// HTTP-level test of the per-user execution rate limit and unfinished-execution cap on the real app.
// Mocked: Prisma is an in-memory fake that emulates pg_advisory_xact_lock (one lock holder per key until its
// transaction ends) and yields between every query, so code that skipped the lock would visibly over-admit.
// The queue is a recording fake. No Postgres or Redis is used; see test/integration for the real-Postgres check.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it, mock } from "node:test";

process.env.EXECUTION_MAX_ACTIVE_PER_USER = "2";
process.env.EXECUTION_RATE_LIMIT = "12";
process.env.EXECUTION_RATE_WINDOW_MS = "60000";

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

const fakePrisma = {
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    let release = () => {};
    const tx = {
      // Tagged template call: the lock key arguments are the interpolated values.
      $executeRaw: async (_sql: TemplateStringsArray, _namespace: number, userId: string) => {
        const previous = locks.get(userId) ?? Promise.resolve();
        let unlock!: () => void;
        const held = new Promise<void>((resolve) => (unlock = resolve));
        locks.set(userId, previous.then(() => held));
        await previous;
        release = unlock;
        events.push(`lock:${userId}`);
        return 1;
      },
      execution: {
        count: async ({ where }: { where: { userId: string; status: { in: string[] } } }) => {
          await yieldToOthers();
          events.push(`count:${where.userId}`);
          return rows.filter((row) => row.userId === where.userId && where.status.in.includes(row.status)).length;
        },
        create: async ({ data }: { data: Omit<Row, "id"> & Record<string, unknown> }) => {
          await yieldToOthers();
          const row = { ...data, id: newId() };
          rows.push(row);
          return row;
        },
      },
    };
    try {
      return await fn(tx);
    } finally {
      release();
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
const { EXECUTION_RATE_LIMIT_MESSAGE } = await import("../../src/middleware/rate-limiters.js");

const CAP_MESSAGE = "You already have 2 unfinished executions. Wait for one to finish before submitting another.";

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
    body: JSON.stringify({ language: "cpp", code: "int main() {}" }),
  });
  return { status: response.status, type: response.headers.get("content-type"), body: (await response.json()) as { success: boolean; message?: string } };
}

const finishAll = (userId: string, status = "COMPLETED") => rows.filter((r) => r.userId === userId).forEach((r) => (r.status = status));

describe("per-user execution rate limit", () => {
  it("returns 429 JSON after 12 requests in the window without blocking another user", async () => {
    for (let i = 0; i < 12; i++) {
      assert.equal((await submit("rate-user")).status, 201, `request ${i + 1}`);
      finishAll("rate-user"); // keep the unfinished cap out of the way
    }

    const limited = await submit("rate-user");
    assert.equal(limited.status, 429);
    assert.match(limited.type ?? "", /application\/json/);
    assert.deepEqual(limited.body, { success: false, message: EXECUTION_RATE_LIMIT_MESSAGE });
    assert.equal(rows.filter((r) => r.userId === "rate-user").length, 12, "the limited request created no row");

    assert.equal((await submit("other-user")).status, 201, "a second user is not limited");
  });
});

describe("unfinished-execution cap", () => {
  it("rejects a third unfinished execution with 429 JSON, creating no row and no job", async () => {
    assert.equal((await submit("cap-user")).status, 201);
    assert.equal((await submit("cap-user")).status, 201);

    const rejected = await submit("cap-user");
    assert.equal(rejected.status, 429);
    assert.match(rejected.type ?? "", /application\/json/);
    assert.deepEqual(rejected.body, { success: false, message: CAP_MESSAGE });
    assert.equal(rows.length, 2);
    assert.equal(queued.length, 2);
  });

  it("does not block another user who is under the cap", async () => {
    await submit("busy-user");
    await submit("busy-user");
    assert.equal((await submit("busy-user")).status, 429);
    assert.equal((await submit("idle-user")).status, 201);
  });

  for (const status of ["COMPLETED", "FAILED", "TIMEOUT"]) {
    it(`frees a slot when an execution becomes ${status}`, async () => {
      await submit(`free-${status}`);
      await submit(`free-${status}`);
      assert.equal((await submit(`free-${status}`)).status, 429);

      rows[0].status = status;
      assert.equal((await submit(`free-${status}`)).status, 201);
    });
  }

  it("counts RUNNING executions toward the cap", async () => {
    await submit("running-user");
    await submit("running-user");
    finishAll("running-user", "RUNNING");
    assert.equal((await submit("running-user")).status, 429);
  });

  it("admits exactly the cap when 10 submissions arrive simultaneously", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => submit("burst-user")));
    const statuses = results.map((r) => r.status).sort();

    assert.deepEqual(statuses, [201, 201, 429, 429, 429, 429, 429, 429, 429, 429]);
    assert.equal(rows.filter((r) => r.userId === "burst-user").length, 2);
    assert.equal(queued.length, 2);
    // Every transaction locked before counting, and no other count for this user ran while a lock was held.
    for (let i = 0; i < events.length; i += 2) {
      assert.deepEqual([events[i], events[i + 1]], ["lock:burst-user", "count:burst-user"], `event ${i}`);
    }
  });

  it("does not serialize different users behind one another's lock", async () => {
    const results = await Promise.all(["u1", "u2", "u3"].flatMap((user) => [submit(user), submit(user), submit(user)]));
    assert.equal(results.filter((r) => r.status === 201).length, 6, "two per user");
    for (const user of ["u1", "u2", "u3"]) assert.equal(rows.filter((r) => r.userId === user).length, 2);
  });
});
