// HTTP-level test of the service-wide (global) unfinished-execution cap on the real app.
// Mocked: Prisma is an in-memory fake that emulates pg_advisory_xact_lock per (namespace, key) and yields between
// every query, so code that counted without holding the global lock would visibly over-admit. The queue is a
// recording fake. No Postgres or Redis is used; see test/integration/execution-limit for the real-Postgres check.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it, mock } from "node:test";

process.env.EXECUTION_MAX_ACTIVE_PER_USER = "2";
process.env.EXECUTION_MAX_ACTIVE_TOTAL = "3";
process.env.EXECUTION_RATE_LIMIT = "1000";

interface Row {
  id: string;
  userId: string;
  status: string;
}

const rows: Row[] = [];
const queued: unknown[] = [];
const events: string[] = [];
const locks = new Map<string, Promise<void>>();
let nextId = 0;

const yieldToOthers = () => new Promise((resolve) => setImmediate(resolve));
const newId = () => `c${(nextId++).toString(36).padStart(24, "0")}`;
const UNFINISHED = ["PENDING", "RUNNING"];

const fakePrisma = {
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const releases: (() => void)[] = [];
    const tx = {
      // Tagged template call: the interpolated values are the lock namespace and key.
      $executeRaw: async (_sql: TemplateStringsArray, namespace: number, key: string | number) => {
        const name = typeof key === "number" ? `global` : key;
        const lockKey = `${namespace}:${key}`;
        const previous = locks.get(lockKey) ?? Promise.resolve();
        let unlock!: () => void;
        const held = new Promise<void>((resolve) => (unlock = resolve));
        locks.set(lockKey, previous.then(() => held));
        await previous;
        releases.push(unlock);
        events.push(`lock:${name}`);
        return 1;
      },
      execution: {
        count: async ({ where }: { where: { userId?: string; status: { in: string[] } } }) => {
          await yieldToOthers();
          events.push(`count:${where.userId ?? "all"}`);
          return rows.filter((row) => (where.userId === undefined || row.userId === where.userId) && where.status.in.includes(row.status)).length;
        },
        create: async ({ data }: { data: Omit<Row, "id"> & Record<string, unknown> }) => {
          await yieldToOthers();
          const row = { ...data, id: newId() };
          rows.push(row);
          events.push(`create:${data.userId}`);
          return row;
        },
      },
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases.reverse()) release();
    }
  },
  execution: {
    updateMany: async () => ({ count: 0 }),
  },
};

mock.module("../../src/lib/prisma.js", { defaultExport: fakePrisma });
mock.module("../../src/queues/execution.queue.js", {
  namedExports: { executionQueue: { add: async (_name: string, data: unknown) => void queued.push(data) } },
});

const { default: app } = await import("../../src/app.js");
const { generateToken } = await import("../../src/utils/jwt.js");
const { AT_CAPACITY_MESSAGE, AT_CAPACITY_RETRY_AFTER_SECONDS } = await import("../../src/controllers/execution.controller.js");

const USER_CAP_MESSAGE = "You already have 2 unfinished executions. Wait for one to finish before submitting another.";

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  rows.length = 0;
  queued.length = 0;
  events.length = 0;
});

async function submit(userId: string) {
  const response = await fetch(`${baseUrl}/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${generateToken(userId)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ language: "java", code: "public class Main { public static void main(String[] a) {} }" }),
  });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"),
    body: (await response.json()) as { success: boolean; message?: string },
  };
}

const unfinished = () => rows.filter((r) => UNFINISHED.includes(r.status)).length;

describe("global unfinished-execution cap", () => {
  it("rejects a submission beyond the global cap with 503 JSON and Retry-After, creating no row and no job", async () => {
    for (const user of ["a", "b", "c"]) assert.equal((await submit(user)).status, 201);

    const rejected = await submit("d");
    assert.equal(rejected.status, 503);
    assert.match(rejected.type ?? "", /application\/json/);
    assert.equal(rejected.retryAfter, String(AT_CAPACITY_RETRY_AFTER_SECONDS));
    assert.deepEqual(rejected.body, { success: false, message: AT_CAPACITY_MESSAGE });
    assert.equal(rows.length, 3, "the rejected submission wrote no execution");
    assert.equal(queued.length, 3, "the rejected submission queued no job");
    assert.ok(!rows.some((r) => r.userId === "d"));
  });

  it("reports the user's own cap (429) before the global cap (503)", async () => {
    await submit("heavy");
    await submit("heavy");
    await submit("light");
    assert.equal(unfinished(), 3, "global cap reached");

    const ownCap = await submit("heavy");
    assert.equal(ownCap.status, 429);
    assert.deepEqual(ownCap.body, { success: false, message: USER_CAP_MESSAGE });
    assert.equal(ownCap.retryAfter, null);
    assert.equal((await submit("newcomer")).status, 503);
  });

  it("frees capacity when any user's execution finishes", async () => {
    for (const user of ["a", "b", "c"]) await submit(user);
    assert.equal((await submit("d")).status, 503);

    rows[0].status = "COMPLETED";
    assert.equal((await submit("d")).status, 201);
    assert.equal((await submit("e")).status, 503);

    rows[1].status = "RUNNING";
    assert.equal((await submit("e")).status, 503, "RUNNING still counts toward the cap");
  });

  it("admits exactly the cap when 12 users submit simultaneously", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => submit(`burst-${i}`)));
    const statuses = results.map((r) => r.status).sort();

    assert.deepEqual(statuses, [201, 201, 201, ...Array(9).fill(503)]);
    assert.equal(rows.length, 3);
    assert.equal(queued.length, 3);
    // The global lock was always taken first and held through both counts (and the insert), so no other
    // submission's count interleaved: each transaction's events are contiguous.
    let i = 0;
    while (i < events.length) {
      assert.equal(events[i], "lock:global", `event ${i}`);
      assert.match(events[i + 1], /^lock:burst-\d+$/);
      const user = events[i + 1].slice("lock:".length);
      assert.deepEqual(events.slice(i + 2, i + 4), [`count:${user}`, "count:all"], `event ${i}`);
      i += events[i + 4] === `create:${user}` ? 5 : 4;
    }
  });
});
