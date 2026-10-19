// HTTP-level test of GET /execute pagination on the real app.
// Mocked: Prisma is an in-memory fake that applies the same where/orderBy/take semantics as the real query; the
// queue is a no-op fake. No Postgres or Redis is used; see test/integration for the real-Postgres check.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it, mock } from "node:test";

interface Row {
  id: string;
  userId: string;
  createdAt: Date;
  status: string;
}

type KeysetWhere = { userId: string; OR?: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }] };

const rows: Row[] = [];
const calls: string[] = [];

const fakePrisma = {
  execution: {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
      calls.push("findFirst");
      const row = rows.find((r) => r.id === where.id && r.userId === where.userId);
      return row ? { id: row.id, createdAt: row.createdAt } : null;
    },
    findMany: async ({ where, orderBy, take }: { where: KeysetWhere; orderBy: unknown; take: number }) => {
      calls.push("findMany");
      assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
      return rows
        .filter((r) => r.userId === where.userId)
        .filter((r) => {
          if (!where.OR) return true;
          const [{ createdAt: { lt } }, tie] = where.OR;
          return r.createdAt < lt || (r.createdAt.getTime() === tie.createdAt.getTime() && r.id < tie.id.lt);
        })
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, take);
    },
  },
};

mock.module("../../src/lib/prisma.js", { defaultExport: fakePrisma });
mock.module("../../src/queues/execution.queue.js", { namedExports: { executionQueue: { add: async () => undefined } } });

const { default: app } = await import("../../src/app.js");
const { generateToken } = await import("../../src/utils/jwt.js");
const { DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE } = await import("../../src/validators/execution.validator.js");

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

let nextId = 0;
const cuid = () => `c${(nextId++).toString(36).padStart(24, "0")}`;

beforeEach(() => {
  rows.length = 0;
  calls.length = 0;
});

/** Adds `count` executions for a user, `sameTimestamp` of them sharing one createdAt to exercise tie-breaking. */
function seed(userId: string, count: number, sameTimestamp = 0) {
  const base = Date.UTC(2026, 9, 1);
  for (let i = 0; i < count; i++) {
    const createdAt = new Date(i < sameTimestamp ? base : base + i * 1000);
    rows.push({ id: cuid(), userId, createdAt, status: "COMPLETED" });
  }
}

type Page = { success: boolean; message?: string; executions?: Row[]; nextCursor?: string | null };

async function list(query = "", userId = "alice", auth = true) {
  const response = await fetch(`${baseUrl}/execute${query}`, { headers: auth ? { Authorization: `Bearer ${generateToken(userId)}` } : {} });
  return { status: response.status, body: (await response.json()) as Page };
}

describe("GET /execute pagination", () => {
  it(`returns the newest ${DEFAULT_HISTORY_PAGE_SIZE} by default with a cursor for the next page`, async () => {
    seed("alice", 25);
    const { status, body } = await list();

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.executions?.length, DEFAULT_HISTORY_PAGE_SIZE);
    assert.equal(body.nextCursor, body.executions?.at(-1)?.id);
  });

  it("returns null nextCursor on the last page", async () => {
    seed("alice", 3);
    const { body } = await list("?limit=3");
    assert.equal(body.executions?.length, 3);
    assert.equal(body.nextCursor, null);
  });

  it("walks every page in stable newest-first order without duplicates or gaps, even with equal timestamps", async () => {
    seed("alice", 23, 9); // 9 share one createdAt; 14 have distinct ones
    const expected = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const { status, body } = await list(`?limit=4${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(status, 200);
      seen.push(...(body.executions ?? []).map((e) => e.id));
      cursor = body.nextCursor;
    } while (cursor);

    assert.deepEqual(seen, expected);
  });

  it(`accepts the maximum page size of ${MAX_HISTORY_PAGE_SIZE}`, async () => {
    seed("alice", MAX_HISTORY_PAGE_SIZE + 5);
    const { status, body } = await list(`?limit=${MAX_HISTORY_PAGE_SIZE}`);
    assert.equal(status, 200);
    assert.equal(body.executions?.length, MAX_HISTORY_PAGE_SIZE);
  });

  for (const [name, query, message] of [
    ["a page size above the maximum", `?limit=${MAX_HISTORY_PAGE_SIZE + 1}`, `limit: Too big: expected number to be <=${MAX_HISTORY_PAGE_SIZE}`],
    ["a zero page size", "?limit=0", "limit: Too small: expected number to be >=1"],
    ["a negative page size", "?limit=-5", "limit: Too small: expected number to be >=1"],
    ["a fractional page size", "?limit=1.5", "limit: Invalid input: expected int, received number"],
    ["a non-numeric page size", "?limit=abc", "limit: Invalid input: expected number, received NaN"],
    ["an empty page size", "?limit=", "limit: Too small: expected number to be >=1"],
    ["a repeated page size", "?limit=1&limit=2", "limit: Invalid input: expected number, received NaN"],
    ["a malformed cursor", "?cursor=not-a-cuid", "cursor: Invalid cursor"],
  ] as const) {
    it(`returns 400 for ${name} without querying the database`, async () => {
      const { status, body } = await list(query);
      assert.equal(status, 400);
      assert.deepEqual(body, { success: false, message });
      assert.deepEqual(calls, []);
    });
  }

  it("requires authentication", async () => {
    const { status } = await list("", "alice", false);
    assert.equal(status, 401);
    assert.deepEqual(calls, []);
  });
});

describe("GET /execute ownership", () => {
  it("returns only the caller's executions", async () => {
    seed("alice", 3);
    seed("bob", 4);
    const { body } = await list("?limit=100", "bob");
    assert.equal(body.executions?.length, 4);
    assert.ok(body.executions?.every((e) => e.userId === "bob"));
  });

  it("rejects another user's execution id as a cursor exactly like a nonexistent one", async () => {
    seed("alice", 3);
    seed("bob", 3);
    const bobsId = rows.find((r) => r.userId === "bob")!.id;

    const foreign = await list(`?cursor=${bobsId}`, "alice");
    const missing = await list(`?cursor=${cuid()}`, "alice");
    assert.equal(foreign.status, 400);
    assert.deepEqual(foreign, missing);
    assert.deepEqual(foreign.body, { success: false, message: "cursor: Invalid cursor" });
  });
});
