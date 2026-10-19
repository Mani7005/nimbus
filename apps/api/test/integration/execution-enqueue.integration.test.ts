// REAL Redis + BullMQ: skipped unless NIMBUS_REDIS_INTEGRATION=1. Uses REDIS_URL from the environment or apps/api/.env
// for the reachable case, and an unused local port for the unreachable case. Postgres is not used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";
import { EnqueueTimeoutError, enqueueExecution } from "../../src/queues/execution.enqueue.js";

const enabled = process.env.NIMBUS_REDIS_INTEGRATION === "1";
const EXECUTION_ID = "cmrm5whp00000ieqonyoqlbge";

describe("enqueueExecution with real BullMQ", { skip: enabled ? false : "set NIMBUS_REDIS_INTEGRATION=1 to run", timeout: 30000 }, () => {
  const cleanups: (() => Promise<unknown>)[] = [];

  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  function createQueue(url: string) {
    const connection = new Redis(url, { maxRetriesPerRequest: null });
    connection.on("error", () => undefined);
    const queue = new Queue(`nimbus-test-${randomUUID()}`, { connection: connection as unknown as ConnectionOptions });
    queue.on("error", () => undefined);
    return { queue, connection };
  }

  it("stores the job under the execution id", async () => {
    const { queue, connection } = createQueue(env.REDIS_URL);
    cleanups.push(() => connection.quit(), () => queue.close(), () => queue.obliterate({ force: true }));

    await enqueueExecution(queue, EXECUTION_ID, 5000);
    const job = await queue.getJob(EXECUTION_ID);
    assert.equal(job?.id, EXECUTION_ID);
    assert.deepEqual(job?.data, { executionId: EXECUTION_ID });
  });

  it("times out instead of hanging when Redis is unreachable", async () => {
    const { queue, connection } = createQueue("redis://127.0.0.1:6399");
    cleanups.push(async () => connection.disconnect());

    const started = Date.now();
    await assert.rejects(enqueueExecution(queue, EXECUTION_ID, 500), EnqueueTimeoutError);
    assert.ok(Date.now() - started < 2000);
  });
});
