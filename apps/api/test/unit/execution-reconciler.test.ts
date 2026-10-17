// Mocked: the execution store, BullMQ state lookup, logger and clock are in-memory fakes; no Postgres or Redis is used.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  RECONCILED_OUTPUT,
  reconcileOrphanedExecutions,
  type JobStateLookup,
  type ReconcileOptions,
  type ReconcileStore,
  type StaleExecution,
} from "../../src/workers/execution.reconciler.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const GRACE_MS = 5 * 60 * 1000;
const OLD = new Date(NOW.getTime() - GRACE_MS - 60_000);

interface Row extends StaleExecution {
  output: string | null;
}

type StateScript = string | Error | "hang";

let rows: Row[];
let states: Map<string, StateScript>;
let liveJobs: { id: string; data: { executionId: string } }[];
let failingUpdates: Set<string>;
let findManyCalls: number;
let stateLookups: string[];
let liveScans: number;
let logs: { level: string; message: string }[];

function row(id: string, status = "RUNNING", createdAt = OLD): Row {
  return { id, status, createdAt, output: null };
}

const store: ReconcileStore = {
  findMany: async ({ where, orderBy, take }) => {
    findManyCalls++;
    assert.deepEqual(orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
    const after = where.OR;
    return rows
      .filter((r) => where.status.in.includes(r.status) && r.createdAt < where.createdAt.lt)
      .filter((r) => {
        if (!after) return true;
        const [{ createdAt: { gt } }, tie] = after;
        return r.createdAt > gt || (r.createdAt.getTime() === tie.createdAt.getTime() && r.id > tie.id.gt);
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, take)
      .map(({ id, status, createdAt }) => ({ id, status, createdAt }));
  },
  updateMany: async ({ where, data }) => {
    if (failingUpdates.has(where.id)) throw new Error("deadlock detected");
    const matched = rows.filter((r) => r.id === where.id && r.status === where.status);
    for (const r of matched) Object.assign(r, data);
    return { count: matched.length };
  },
};

const queue: JobStateLookup = {
  getJobState: async (id) => {
    stateLookups.push(id);
    const script = states.get(id) ?? "unknown";
    if (script === "hang") return new Promise(() => undefined);
    if (script instanceof Error) throw script;
    return script;
  },
  getJobCounts: async (...types) => {
    liveScans++;
    return Object.fromEntries(types.map((type) => [type, type === "waiting" ? liveJobs.length : 0]));
  },
  getJobs: async () => liveJobs,
};

function reconcile(overrides: Partial<ReconcileOptions> = {}) {
  return reconcileOrphanedExecutions({
    store,
    queue,
    graceMs: GRACE_MS,
    now: () => NOW,
    lookupTimeoutMs: 30,
    logger: {
      log: (message: string) => logs.push({ level: "log", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
    },
    ...overrides,
  });
}

function statusOf(id: string) {
  return rows.find((r) => r.id === id)?.status;
}

beforeEach(() => {
  rows = [];
  states = new Map();
  liveJobs = [];
  failingUpdates = new Set();
  findManyCalls = 0;
  stateLookups = [];
  liveScans = 0;
  logs = [];
});

describe("job states", () => {
  for (const state of ["waiting", "active", "delayed", "prioritized", "waiting-children", "some-future-state"]) {
    it(`leaves the execution alone when its job is ${state}`, async () => {
      rows = [row("exec-1", "RUNNING")];
      states.set("exec-1", state);
      const summary = await reconcile();
      assert.equal(statusOf("exec-1"), "RUNNING");
      assert.equal(summary.inProgress, 1);
      assert.equal(summary.markedFailed, 0);
    });
  }

  for (const state of ["completed", "failed"]) {
    it(`marks the execution FAILED when its job is ${state} but the result was never saved`, async () => {
      rows = [row("exec-1", "RUNNING")];
      states.set("exec-1", state);
      const summary = await reconcile();
      assert.equal(statusOf("exec-1"), "FAILED");
      assert.equal(rows[0].output, RECONCILED_OUTPUT);
      assert.equal(summary.markedFailed, 1);
    });
  }

  it("marks a PENDING execution with no job FAILED", async () => {
    rows = [row("exec-1", "PENDING")];
    const summary = await reconcile();
    assert.equal(statusOf("exec-1"), "FAILED");
    assert.equal(summary.markedFailed, 1);
  });

  it("uses a safe message with no infrastructure details", async () => {
    rows = [row("exec-1")];
    states.set("exec-1", "failed");
    await reconcile();
    assert.doesNotMatch(rows[0].output ?? "", /redis|bullmq|job|failed \(/i);
  });

  it("looks the job up by execution id", async () => {
    rows = [row("exec-1"), row("exec-2")];
    states.set("exec-1", "waiting").set("exec-2", "waiting");
    await reconcile();
    assert.deepEqual(stateLookups, ["exec-1", "exec-2"]);
  });
});

describe("grace period", () => {
  it("ignores executions younger than the grace period, including exactly at the cutoff", async () => {
    const cutoff = new Date(NOW.getTime() - GRACE_MS);
    rows = [row("fresh", "PENDING", new Date(NOW.getTime() - 1000)), row("at-cutoff", "PENDING", cutoff), row("old", "PENDING")];
    const summary = await reconcile();
    assert.deepEqual(stateLookups, ["old"]);
    assert.equal(statusOf("fresh"), "PENDING");
    assert.equal(statusOf("at-cutoff"), "PENDING");
    assert.equal(summary.scanned, 1);
  });

  it("uses the injected clock and grace period", async () => {
    rows = [row("exec-1", "PENDING", new Date(NOW.getTime() - 2000))];
    await reconcile({ graceMs: 1000 });
    assert.equal(statusOf("exec-1"), "FAILED");
  });
});

describe("jobs enqueued before jobId = execution.id", () => {
  it("leaves the execution alone when a live legacy job references it", async () => {
    rows = [row("exec-legacy", "PENDING")];
    liveJobs = [{ id: "17", data: { executionId: "exec-legacy" } }];
    const summary = await reconcile();
    assert.equal(statusOf("exec-legacy"), "PENDING");
    assert.equal(summary.inProgress, 1);
  });

  it("fails the execution when no live job, legacy or new, references it", async () => {
    rows = [row("exec-orphan", "PENDING")];
    liveJobs = [{ id: "17", data: { executionId: "someone-else" } }];
    await reconcile();
    assert.equal(statusOf("exec-orphan"), "FAILED");
  });

  it("leaves unknown-job executions untouched when there are too many live jobs to scan completely", async () => {
    rows = [row("exec-1", "PENDING")];
    liveJobs = [{ id: "1", data: { executionId: "a" } }, { id: "2", data: { executionId: "b" } }];
    const summary = await reconcile({ legacyScanLimit: 1 });
    assert.equal(statusOf("exec-1"), "PENDING");
    assert.equal(summary.skipped, 1);
  });

  it("leaves unknown-job executions untouched when the live-job scan fails", async () => {
    rows = [row("exec-1", "PENDING")];
    const failingScan: JobStateLookup = { ...queue, getJobCounts: async () => Promise.reject(new Error("READONLY")) };
    const summary = await reconcile({ queue: failingScan });
    assert.equal(statusOf("exec-1"), "PENDING");
    assert.equal(summary.skipped, 1);
    assert.ok(logs.some((log) => /could not scan live jobs: READONLY/.test(log.message)));
  });

  it("scans live jobs at most once per sweep, and only when needed", async () => {
    rows = [row("a", "PENDING"), row("b", "PENDING"), row("c", "RUNNING")];
    states.set("c", "active");
    await reconcile();
    assert.equal(liveScans, 1);

    rows = [row("d", "RUNNING")];
    states.set("d", "active");
    liveScans = 0;
    await reconcile();
    assert.equal(liveScans, 0);
  });

  it("ignores live jobs with malformed data", async () => {
    rows = [row("exec-1", "PENDING")];
    liveJobs = [{ id: "1", data: {} as { executionId: string } }];
    const broken: JobStateLookup = { ...queue, getJobs: async () => [undefined, ...liveJobs] };
    await reconcile({ queue: broken });
    assert.equal(statusOf("exec-1"), "FAILED");
  });
});

describe("terminal records and conditional updates", () => {
  it("never selects or updates terminal executions", async () => {
    rows = ["COMPLETED", "FAILED", "TIMEOUT"].map((status, index) => row(`done-${index}`, status));
    for (const r of rows) states.set(r.id, "failed");
    const summary = await reconcile();
    assert.equal(summary.scanned, 0);
    assert.deepEqual(rows.map((r) => r.status), ["COMPLETED", "FAILED", "TIMEOUT"]);
  });

  it("conditions the update on the status that was read", async () => {
    rows = [row("exec-1", "RUNNING")];
    states.set("exec-1", "completed");
    const racing: JobStateLookup = {
      ...queue,
      getJobState: async (id) => {
        rows[0].status = "COMPLETED";
        rows[0].output = "42";
        return queue.getJobState(id);
      },
    };
    const summary = await reconcile({ queue: racing });
    assert.equal(statusOf("exec-1"), "COMPLETED");
    assert.equal(rows[0].output, "42");
    assert.equal(summary.markedFailed, 0);
  });

  it("does not fail an execution that moved from PENDING to RUNNING mid-sweep", async () => {
    rows = [row("exec-1", "PENDING")];
    const racing: JobStateLookup = {
      ...queue,
      getJobState: async () => {
        rows[0].status = "RUNNING";
        return "unknown";
      },
    };
    await reconcile({ queue: racing });
    assert.equal(statusOf("exec-1"), "RUNNING");
  });
});

describe("jobs removed by queue retention", () => {
  it("never changes a finished execution whose job has been removed", async () => {
    rows = ["COMPLETED", "FAILED", "TIMEOUT"].map((status, index) => ({ ...row(`done-${index}`, status), output: `result ${index}` }));
    // No state scripted: every lookup returns "unknown", exactly as for a removed job, and no live job refers to them.
    const summary = await reconcile();

    assert.equal(summary.scanned, 0);
    assert.equal(summary.markedFailed, 0);
    assert.deepEqual(rows.map((r) => [r.status, r.output]), [["COMPLETED", "result 0"], ["FAILED", "result 1"], ["TIMEOUT", "result 2"]]);
    assert.deepEqual(stateLookups, [], "finished executions are not even looked up");
  });

  it("does not overwrite an execution that finishes while its removed job is being looked up", async () => {
    rows = [row("exec-1", "RUNNING")];
    const racing: JobStateLookup = {
      ...queue,
      getJobState: async () => {
        rows[0].status = "COMPLETED";
        rows[0].output = "42";
        return "unknown";
      },
    };
    const summary = await reconcile({ queue: racing });

    assert.equal(statusOf("exec-1"), "COMPLETED");
    assert.equal(rows[0].output, "42");
    assert.equal(summary.markedFailed, 0);
  });
});

describe("Redis lookup failures", () => {
  it("leaves an execution untouched when its lookup fails and continues with the rest", async () => {
    rows = [row("a"), row("b"), row("c")];
    states.set("a", "failed").set("b", new Error("ECONNRESET")).set("c", "failed");
    const summary = await reconcile();
    assert.deepEqual(rows.map((r) => r.status), ["FAILED", "RUNNING", "FAILED"]);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.markedFailed, 2);
    assert.equal(summary.aborted, false);
  });

  it("times out a hanging lookup and leaves that execution untouched", async () => {
    rows = [row("a"), row("b")];
    states.set("a", "hang").set("b", "failed");
    const summary = await reconcile();
    assert.deepEqual(rows.map((r) => r.status), ["RUNNING", "FAILED"]);
    assert.ok(logs.some((log) => /a untouched, job lookup failed: Redis lookup timed out after 30ms/.test(log.message)));
    assert.equal(summary.skipped, 1);
  });

  it("stops the sweep when Redis appears to be down instead of failing anything", async () => {
    rows = Array.from({ length: 10 }, (_, index) => row(`exec-${index}`, "PENDING"));
    for (const r of rows) states.set(r.id, new Error("Connection is closed"));
    const summary = await reconcile({ maxConsecutiveLookupFailures: 3 });
    assert.ok(rows.every((r) => r.status === "PENDING"));
    assert.equal(summary.aborted, true);
    assert.equal(summary.skipped, 3);
    assert.equal(stateLookups.length, 3);
  });

  it("resets the consecutive-failure count after a successful lookup", async () => {
    rows = ["a", "b", "c", "d", "e"].map((id) => row(id));
    states.set("a", new Error("x")).set("b", new Error("x")).set("c", "waiting").set("d", new Error("x")).set("e", new Error("x"));
    const summary = await reconcile({ maxConsecutiveLookupFailures: 3 });
    assert.equal(summary.aborted, false);
    assert.equal(summary.scanned, 5);
  });
});

describe("database failures", () => {
  it("logs an update failure and continues with the batch", async () => {
    rows = [row("a"), row("b")];
    states.set("a", "failed").set("b", "failed");
    failingUpdates.add("a");
    const summary = await reconcile();
    assert.deepEqual(rows.map((r) => r.status), ["RUNNING", "FAILED"]);
    assert.equal(summary.errors, 1);
    assert.ok(logs.some((log) => log.level === "error" && /could not update execution a: deadlock detected/.test(log.message)));
  });

  it("resolves with an aborted summary when loading executions fails", async () => {
    const broken: ReconcileStore = { ...store, findMany: async () => Promise.reject(new Error("db down")) };
    const summary = await reconcile({ store: broken });
    assert.equal(summary.aborted, true);
    assert.equal(summary.errors, 1);
  });
});

describe("batch boundaries", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `exec-${String(index).padStart(2, "0")}`);

  it("pages through all old executions in bounded batches", async () => {
    rows = ids(5).map((id) => row(id));
    for (const r of rows) states.set(r.id, "failed");
    const summary = await reconcile({ batchSize: 2 });
    assert.equal(summary.markedFailed, 5);
    assert.equal(findManyCalls, 3);
  });

  it("does not skip records when earlier ones are updated mid-sweep or share a timestamp", async () => {
    rows = ids(6).map((id) => row(id));
    rows.forEach((r, index) => states.set(r.id, index % 2 ? "waiting" : "failed"));
    const summary = await reconcile({ batchSize: 2 });
    assert.equal(summary.scanned, 6);
    assert.equal(summary.markedFailed, 3);
    assert.equal(summary.inProgress, 3);
  });

  it("stops after maxBatches", async () => {
    rows = ids(10).map((id) => row(id));
    for (const r of rows) states.set(r.id, "waiting");
    const summary = await reconcile({ batchSize: 2, maxBatches: 2 });
    assert.equal(summary.scanned, 4);
    assert.equal(findManyCalls, 2);
  });

  it("handles a row count that is an exact multiple of the batch size", async () => {
    rows = ids(4).map((id) => row(id));
    for (const r of rows) states.set(r.id, "waiting");
    const summary = await reconcile({ batchSize: 2 });
    assert.equal(summary.scanned, 4);
    assert.equal(findManyCalls, 3);
  });

  it("processes oldest executions first", async () => {
    rows = [row("newer", "RUNNING", new Date(OLD.getTime() + 1000)), row("older", "RUNNING", new Date(OLD.getTime() - 1000))];
    for (const r of rows) states.set(r.id, "waiting");
    await reconcile();
    assert.deepEqual(stateLookups, ["older", "newer"]);
  });
});
