// Mocked: Prisma and the BullMQ queue are scripted in-memory fakes; no Postgres or Redis is used.
// See test/integration/execution-enqueue.integration.test.ts for the real-Redis checks.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it, mock } from "node:test";

process.env.JWT_SECRET = "nimbus-test-secret-at-least-32-characters";
process.env.EXECUTION_ENQUEUE_TIMEOUT_MS = "50";

const VALID_ID = "cmrm5whp00000ieqonyoqlbge";

type AddBehavior = "resolve" | "reject" | "hang" | "late-reject";
type UpdateBehavior = "updated" | "already-left-pending" | "throw";

let addBehavior: AddBehavior;
let updateBehavior: UpdateBehavior;
const addCalls: unknown[][] = [];
const updateCalls: unknown[] = [];
const errorLogs: string[] = [];
const unhandled: unknown[] = [];

const fakeQueue = {
  add: (...args: unknown[]) => {
    addCalls.push(args);
    switch (addBehavior) {
      case "resolve":
        return Promise.resolve({ id: VALID_ID });
      case "reject":
        return Promise.reject(new Error("OOM command not allowed when used memory > 'maxmemory'"));
      case "hang":
        return new Promise(() => undefined);
      case "late-reject":
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Connection is closed")), 120));
    }
  },
};

const fakePrisma = {
  // The per-user limit transaction: lock, count (always 0 here), then create.
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakePrisma),
  $executeRaw: async () => 1,
  execution: {
    count: async () => 0,
    create: async ({ data }: { data: Record<string, unknown> }) => ({ id: VALID_ID, ...data }),
    updateMany: async (args: unknown) => {
      updateCalls.push(args);
      if (updateBehavior === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      return { count: updateBehavior === "updated" ? 1 : 0 };
    },
  },
};

mock.module("../../src/lib/prisma.js", { defaultExport: fakePrisma });
mock.module("../../src/queues/execution.queue.js", { namedExports: { executionQueue: fakeQueue } });

const { default: app } = await import("../../src/app.js");
const { generateToken } = await import("../../src/utils/jwt.js");
const { ENQUEUE_FAILED_OUTPUT } = await import("../../src/services/execution.service.js");
const { EnqueueTimeoutError, enqueueExecution } = await import("../../src/queues/execution.enqueue.js");

const UNAVAILABLE = { success: false, message: "Execution service unavailable. Please try again." };
const COMPENSATION = { where: { id: VALID_ID, status: "PENDING" }, data: { status: "FAILED", output: ENQUEUE_FAILED_OUTPUT } };
const onUnhandled = (reason: unknown) => unhandled.push(reason);

let server: ReturnType<typeof app.listen>;
let baseUrl = "";
const token = generateToken("user-1");

before(async () => {
  process.on("unhandledRejection", onUnhandled);
  mock.method(console, "error", (message: string) => void errorLogs.push(message));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  process.off("unhandledRejection", onUnhandled);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  addBehavior = "resolve";
  updateBehavior = "updated";
  addCalls.length = 0;
  updateCalls.length = 0;
  errorLogs.length = 0;
  unhandled.length = 0;
});

async function submit() {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ language: "cpp", code: "int main() {}" }),
  });
  return { status: response.status, body: await response.json(), elapsedMs: Date.now() - started };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("enqueueExecution", () => {
  it("adds the job under the execution id", async () => {
    await enqueueExecution(fakeQueue, VALID_ID, 50);
    assert.deepEqual(addCalls, [["execute-code", { executionId: VALID_ID }, { jobId: VALID_ID }]]);
  });

  it("rejects with the queue error", async () => {
    addBehavior = "reject";
    await assert.rejects(enqueueExecution(fakeQueue, VALID_ID, 50), /maxmemory/);
  });

  it("rejects with EnqueueTimeoutError when add never settles", async () => {
    addBehavior = "hang";
    await assert.rejects(enqueueExecution(fakeQueue, VALID_ID, 30), EnqueueTimeoutError);
  });

  it("rejects instead of throwing when add throws synchronously", async () => {
    const throwing = {
      add: () => {
        throw new Error("sync boom");
      },
    };
    await assert.rejects(enqueueExecution(throwing, VALID_ID, 50), /sync boom/);
  });

  it("ignores a late rejection from an add that already timed out", async () => {
    addBehavior = "late-reject";
    await assert.rejects(enqueueExecution(fakeQueue, VALID_ID, 30), EnqueueTimeoutError);
    await settle(150);
    assert.deepEqual(unhandled, []);
  });
});

describe("POST /execute enqueue handoff", () => {
  it("returns the unchanged 201 and enqueues with jobId = execution id", async () => {
    const { status, body } = await submit();
    assert.equal(status, 201);
    assert.deepEqual(body, {
      success: true,
      execution: { id: VALID_ID, language: "cpp", code: "int main() {}", input: "", userId: "user-1", status: "PENDING" },
    });
    assert.deepEqual(addCalls, [["execute-code", { executionId: VALID_ID }, { jobId: VALID_ID }]]);
    assert.deepEqual(updateCalls, []);
  });

  it("returns 503 and marks the PENDING execution FAILED when enqueue rejects", async () => {
    addBehavior = "reject";
    const { status, body } = await submit();
    assert.equal(status, 503);
    assert.deepEqual(body, UNAVAILABLE);
    assert.deepEqual(updateCalls, [COMPENSATION]);
    assert.ok(errorLogs.some((log) => log.startsWith(`Could not enqueue execution ${VALID_ID}`)));
  });

  it("returns 503 within the timeout when enqueue hangs", async () => {
    addBehavior = "hang";
    const { status, body, elapsedMs } = await submit();
    assert.equal(status, 503);
    assert.deepEqual(body, UNAVAILABLE);
    assert.deepEqual(updateCalls, [COMPENSATION]);
    assert.ok(elapsedMs < 1000, `responded after ${elapsedMs}ms`);
    assert.ok(errorLogs.some((log) => log.includes("Enqueue timed out after 50ms")));
  });

  it("still returns 503 and logs when the compensating write fails", async () => {
    addBehavior = "reject";
    updateBehavior = "throw";
    const { status, body } = await submit();
    await settle(20);
    assert.equal(status, 503);
    assert.deepEqual(body, UNAVAILABLE);
    assert.ok(errorLogs.some((log) => log.startsWith(`Could not mark execution ${VALID_ID} FAILED`) && log.includes("ECONNREFUSED")));
    assert.deepEqual(unhandled, []);
  });

  it("returns the normal 201 when the execution already left PENDING during a timed-out enqueue", async () => {
    addBehavior = "hang";
    updateBehavior = "already-left-pending";
    const { status, body } = await submit();
    assert.equal(status, 201);
    assert.equal(body.success, true);
    assert.equal(body.execution.id, VALID_ID);
    assert.deepEqual(updateCalls, [COMPENSATION], "the write is conditional on PENDING, so it cannot overwrite RUNNING or a result");
  });

  it("does not leak an unhandled rejection when a timed-out enqueue later rejects", async () => {
    addBehavior = "late-reject";
    const { status } = await submit();
    await settle(150);
    assert.equal(status, 503);
    assert.deepEqual(unhandled, []);
  });
});
