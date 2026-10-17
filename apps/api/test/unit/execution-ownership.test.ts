// Mocked: Prisma and the BullMQ queue are replaced by in-memory fakes; no Postgres or Redis is used.
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import type { Response } from "express";
import type { AuthRequest } from "../../src/middleware/auth.middleware.js";

interface StoredExecution {
  id: string;
  userId: string;
  code: string;
}

interface Where {
  id?: string;
  userId?: string;
}

const store: StoredExecution[] = [];
const calls: { method: string; where: Where }[] = [];
const matches = (where: Where) => (execution: StoredExecution) =>
  Object.entries(where).every(([key, value]) => execution[key as keyof StoredExecution] === value);

const fakePrisma = {
  execution: {
    findFirst: async ({ where }: { where: Where }) => {
      calls.push({ method: "findFirst", where });
      return store.find(matches(where)) ?? null;
    },
    deleteMany: async ({ where }: { where: Where }) => {
      calls.push({ method: "deleteMany", where });
      const remaining = store.filter((execution) => !matches(where)(execution));
      const count = store.length - remaining.length;
      store.splice(0, store.length, ...remaining);
      return { count };
    },
    findUnique: async () => assert.fail("unscoped findUnique must not be used"),
    delete: async () => assert.fail("unscoped delete must not be used"),
  },
};

mock.module("../../src/lib/prisma.js", { defaultExport: fakePrisma });
mock.module("../../src/queues/execution.queue.js", { namedExports: { executionQueue: { add: async () => undefined } } });

const { getExecution, deleteExecution } = await import("../../src/services/execution.service.js");
const { getExecutionById, removeExecution } = await import("../../src/controllers/execution.controller.js");

const OWNER = "user-owner";
const OTHER = "user-other";

function request(id: string, userId: string): AuthRequest {
  return { params: { id }, userId } as unknown as AuthRequest;
}

function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res as typeof res & Response;
}

const NOT_FOUND = { success: false, message: "Execution not found" };

beforeEach(() => {
  store.splice(0, store.length, { id: "exec-1", userId: OWNER, code: "secret code" });
  calls.length = 0;
});

describe("execution service ownership", () => {
  it("returns an execution to its owner, querying by id and userId", async () => {
    const execution = await getExecution("exec-1", OWNER);
    assert.equal(execution?.id, "exec-1");
    assert.deepEqual(calls, [{ method: "findFirst", where: { id: "exec-1", userId: OWNER } }]);
  });

  it("returns null for another user's execution", async () => {
    assert.equal(await getExecution("exec-1", OTHER), null);
  });

  it("deletes only the owner's execution", async () => {
    assert.equal(await deleteExecution("exec-1", OWNER), true);
    assert.equal(store.length, 0);
    assert.deepEqual(calls, [{ method: "deleteMany", where: { id: "exec-1", userId: OWNER } }]);
  });

  it("does not delete another user's execution", async () => {
    assert.equal(await deleteExecution("exec-1", OTHER), false);
    assert.equal(store.length, 1);
  });

  it("returns false instead of throwing for a nonexistent execution", async () => {
    assert.equal(await deleteExecution("missing", OWNER), false);
  });
});

describe("execution controller ownership", () => {
  it("returns the owner's execution", async () => {
    const res = response();
    await getExecutionById(request("exec-1", OWNER), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, execution: store[0] });
  });

  it("returns the same 404 for another user's execution and a missing one", async () => {
    const foreign = response();
    const missing = response();
    await getExecutionById(request("exec-1", OTHER), foreign);
    await getExecutionById(request("missing", OTHER), missing);

    assert.equal(foreign.statusCode, 404);
    assert.deepEqual(foreign.body, NOT_FOUND);
    assert.equal(missing.statusCode, foreign.statusCode);
    assert.deepEqual(missing.body, foreign.body);
  });

  it("deletes the owner's execution with the existing success response", async () => {
    const res = response();
    await removeExecution(request("exec-1", OWNER), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: "Execution deleted successfully" });
    assert.equal(store.length, 0);
  });

  it("returns 404 and keeps the execution when another user deletes it", async () => {
    const res = response();
    await removeExecution(request("exec-1", OTHER), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal(store.length, 1);
  });

  it("returns 404 when deleting a nonexistent execution", async () => {
    const res = response();
    await removeExecution(request("missing", OWNER), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, NOT_FOUND);
  });
});
