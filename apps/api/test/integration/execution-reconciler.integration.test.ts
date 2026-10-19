// REAL Redis + BullMQ: skipped unless NIMBUS_REDIS_INTEGRATION=1. Uses REDIS_URL from the environment or apps/api/.env.
// Postgres is faked; jobs go to a throwaway queue that is obliterated afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";
import {
  RECONCILED_OUTPUT,
  reconcileOrphanedExecutions,
  type ReconcileStore,
  type StaleExecution,
} from "../../src/workers/execution.reconciler.js";

const enabled = process.env.NIMBUS_REDIS_INTEGRATION === "1";
const OLD = new Date(Date.now() - 60 * 60 * 1000);

interface Row extends StaleExecution {
  output: string | null;
}

const rows = new Map<string, Row>();

const store: ReconcileStore = {
  findMany: async ({ where, take }) =>
    [...rows.values()]
      .filter((r) => where.status.in.includes(r.status) && r.createdAt < where.createdAt.lt)
      .filter((r) => !where.OR || r.id > where.OR[1].id.gt)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, take),
  updateMany: async ({ where, data }) => {
    const r = rows.get(where.id);
    if (!r || r.status !== where.status) return { count: 0 };
    Object.assign(r, data);
    return { count: 1 };
  },
};

const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

function addRow(label: string, status = "RUNNING"): string {
  const id = `${label}-${randomUUID()}`;
  rows.set(id, { id, status, createdAt: OLD, output: null });
  return id;
}

describe("reconcileOrphanedExecutions with real BullMQ", { skip: enabled ? false : "set NIMBUS_REDIS_INTEGRATION=1 to run", timeout: 30000 }, () => {
  let connection: Redis;
  let queue: Queue;
  const ids: Record<string, string> = {};

  before(async () => {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const shared = connection as unknown as ConnectionOptions;
    queue = new Queue(`nimbus-test-${randomUUID()}`, { connection: shared });

    // Jobs that terminally fail: one under the new jobId convention, one with a legacy auto-generated id.
    ids.failedJob = addRow("failed-job");
    ids.legacyFailed = addRow("legacy-failed");
    await queue.add("execute-code", { executionId: ids.failedJob }, { jobId: ids.failedJob });
    await queue.add("execute-code", { executionId: ids.legacyFailed });
    const worker = new Worker(queue.name, async () => {
      throw new Error("db down");
    }, { connection: shared });
    while ((await queue.getJobCounts("failed")).failed < 2) await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.close();

    // Jobs that are still waiting (no worker running any more).
    ids.waitingJob = addRow("waiting-job", "PENDING");
    ids.legacyWaiting = addRow("legacy-waiting", "PENDING");
    await queue.add("execute-code", { executionId: ids.waitingJob }, { jobId: ids.waitingJob });
    const legacy = await queue.add("execute-code", { executionId: ids.legacyWaiting });
    ids.legacyWaitingJobId = legacy.id!;

    ids.missingJob = addRow("missing-job", "PENDING");
    ids.completedRow = addRow("completed-row", "COMPLETED");
  });

  after(async () => {
    await queue?.obliterate({ force: true });
    await queue?.close();
    await connection?.quit();
  });

  it("confirms legacy jobs are invisible to a lookup by execution id", async () => {
    assert.match(ids.legacyWaitingJobId, /^\d+$/);
    assert.equal(await queue.getJobState(ids.legacyWaiting), "unknown");
    assert.equal(await queue.getJobState(ids.legacyWaitingJobId), "waiting");
  });

  it("fails only executions whose jobs are finished or missing", async () => {
    const summary = await reconcileOrphanedExecutions({ store, queue, graceMs: 5 * 60 * 1000, logger: silent });

    assert.equal(rows.get(ids.failedJob)?.status, "FAILED");
    assert.equal(rows.get(ids.failedJob)?.output, RECONCILED_OUTPUT);
    assert.equal(rows.get(ids.legacyFailed)?.status, "FAILED");
    assert.equal(rows.get(ids.missingJob)?.status, "FAILED");

    assert.equal(rows.get(ids.waitingJob)?.status, "PENDING");
    assert.equal(rows.get(ids.legacyWaiting)?.status, "PENDING", "a waiting legacy job must not be falsely failed");
    assert.equal(rows.get(ids.completedRow)?.status, "COMPLETED");

    assert.deepEqual({ markedFailed: summary.markedFailed, inProgress: summary.inProgress, skipped: summary.skipped }, { markedFailed: 3, inProgress: 2, skipped: 0 });
  });

  it("leaves everything untouched when Redis is unreachable", async () => {
    const down = new Redis("redis://127.0.0.1:6399", { maxRetriesPerRequest: null });
    down.on("error", () => undefined);
    const unreachable = new Queue(queue.name, { connection: down as unknown as ConnectionOptions });
    unreachable.on("error", () => undefined);
    const orphan = addRow("unreachable", "PENDING");

    try {
      const summary = await reconcileOrphanedExecutions({ store, queue: unreachable, graceMs: 1000, logger: silent, lookupTimeoutMs: 200 });
      assert.equal(summary.aborted, true);
      assert.equal(summary.markedFailed, 0);
      assert.equal(rows.get(orphan)?.status, "PENDING");
    } finally {
      down.disconnect();
    }
  });
});
