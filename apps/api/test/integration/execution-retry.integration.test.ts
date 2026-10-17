// REAL Redis + BullMQ: skipped unless NIMBUS_REDIS_INTEGRATION=1. Uses REDIS_URL from the environment or apps/api/.env.
// Postgres and Docker are faked; each run uses a throwaway queue name that is obliterated afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";
import { EXECUTION_JOB_OPTIONS, type ExecutionJobData } from "../../src/queues/execution.job.js";
import { INFRASTRUCTURE_ERROR_OUTPUT, type ExecutionResult } from "../../src/runtime/execution-result.js";
import {
  handleFailedExecutionJob,
  processExecutionJob,
  type ExecutionJobDeps,
  type ExecutionStore,
} from "../../src/workers/execution.processor.js";

const enabled = process.env.NIMBUS_REDIS_INTEGRATION === "1";

interface Row {
  id: string;
  language: string;
  code: string;
  input: string | null;
  status: string;
  output: string | null;
  history: string[];
}

const rows = new Map<string, Row>();
const scripted = new Map<string, ExecutionResult[]>();

const store: ExecutionStore = {
  findUnique: async ({ where }) => rows.get(where.id) ?? null,
  updateMany: async ({ where, data }) => {
    const row = rows.get(where.id);
    if (!row || !where.status.in.includes(row.status)) return { count: 0 };
    Object.assign(row, data);
    row.history.push(data.status);
    return { count: 1 };
  },
};

const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
const deps: ExecutionJobDeps = {
  executions: store,
  logger: silent,
  executeCpp: async (code) => {
    const queue = scripted.get(code)!;
    return queue.length > 1 ? queue.shift()! : queue[0];
  },
};

function outcome(fields: Partial<ExecutionResult> & Pick<ExecutionResult, "outcome">): ExecutionResult {
  return { stdout: "", stderr: "", compileOutput: "", exitCode: 0, message: "", ...fields };
}

const infra = outcome({ outcome: "INFRASTRUCTURE_ERROR", message: "docker daemon down" });

describe("execution job retries with real BullMQ", { skip: enabled ? false : "set NIMBUS_REDIS_INTEGRATION=1 to run", timeout: 60000 }, () => {
  const queueName = `nimbus-test-${randomUUID()}`;
  let connection: Redis;
  let queue: Queue<ExecutionJobData>;
  let worker: Worker<ExecutionJobData>;
  const failedHandlers: Promise<void>[] = [];

  before(async () => {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const shared = connection as unknown as ConnectionOptions;
    queue = new Queue<ExecutionJobData>(queueName, { connection: shared, defaultJobOptions: EXECUTION_JOB_OPTIONS });
    worker = new Worker<ExecutionJobData>(queueName, (job) => processExecutionJob(job, deps), { connection: shared });
    worker.on("failed", (job, error) => failedHandlers.push(handleFailedExecutionJob(job, error, deps)));
    await worker.waitUntilReady();
  });

  after(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    await connection?.quit();
  });

  async function run(code: string, results: ExecutionResult[]) {
    const id = randomUUID();
    rows.set(id, { id, language: "cpp", code, input: "", status: "PENDING", output: null, history: [] });
    scripted.set(code, results);
    const job = await queue.add("execute-code", { executionId: id });

    const deadline = Date.now() + 30000;
    let state = await job.getState();
    while (state !== "completed" && state !== "failed") {
      assert.ok(Date.now() < deadline, `job stuck in state ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await job.getState();
    }
    await Promise.all(failedHandlers);
    const finished = await queue.getJob(job.id!);
    return { row: rows.get(id)!, state, attemptsMade: finished!.attemptsMade };
  }

  it("does not retry a user-code failure", async () => {
    const { row, state, attemptsMade } = await run("compile-error", [outcome({ outcome: "COMPILATION_ERROR", compileOutput: "error: x" })]);
    assert.equal(state, "completed");
    assert.equal(attemptsMade, 1);
    assert.deepEqual(row.history, ["RUNNING", "FAILED"]);
    assert.equal(row.output, "error: x");
  });

  it("retries a transient failure and then succeeds", async () => {
    const { row, state, attemptsMade } = await run("flaky", [infra, infra, outcome({ outcome: "SUCCESS", stdout: "ok" })]);
    assert.equal(state, "completed");
    assert.equal(attemptsMade, 3);
    assert.deepEqual(row.history, ["RUNNING", "PENDING", "RUNNING", "PENDING", "RUNNING", "COMPLETED"]);
    assert.equal(row.output, "ok");
  });

  it("marks the execution FAILED only after the final attempt", async () => {
    const { row, state, attemptsMade } = await run("always-down", [infra]);
    assert.equal(state, "failed");
    assert.equal(attemptsMade, 3);
    assert.deepEqual(row.history, ["RUNNING", "PENDING", "RUNNING", "PENDING", "RUNNING", "FAILED"]);
    assert.equal(row.output, INFRASTRUCTURE_ERROR_OUTPUT);
  });
});
