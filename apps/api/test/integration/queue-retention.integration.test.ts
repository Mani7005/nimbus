// REAL Redis + BullMQ: skipped unless NIMBUS_REDIS_INTEGRATION=1. Uses REDIS_URL from the environment or apps/api/.env.
// Each test uses a throwaway queue name that is obliterated afterwards; the execution queue is never touched.
// Postgres is faked for the reconciler check.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Queue, QueueEvents, Worker, type ConnectionOptions, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";
import { COMPLETED_JOB_RETENTION, EXECUTION_JOB_OPTIONS, FAILED_JOB_RETENTION } from "../../src/queues/execution.job.js";
import { reconcileOrphanedExecutions, type ReconcileStore, type StaleExecution } from "../../src/workers/execution.reconciler.js";

const enabled = process.env.NIMBUS_REDIS_INTEGRATION === "1";
const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

describe("execution job retention with real BullMQ", { skip: enabled ? false : "set NIMBUS_REDIS_INTEGRATION=1 to run", timeout: 60000 }, () => {
  let connection: Redis;
  let shared: ConnectionOptions;
  const cleanups: (() => Promise<unknown>)[] = [];

  before(() => {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    shared = connection as unknown as ConnectionOptions;
  });

  after(async () => {
    // In registration order: each queue's worker and listeners close before the queue is obliterated and closed.
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
    await connection.quit();
  });

  /** A throwaway queue whose worker succeeds unless the job data says fail. */
  async function testQueue(defaultJobOptions: JobsOptions) {
    const queue = new Queue(`nimbus-test-${randomUUID()}`, { connection: shared, defaultJobOptions });
    // QueueEvents blocks on its connection, so it gets its own.
    const eventsConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const events = new QueueEvents(queue.name, { connection: eventsConnection as unknown as ConnectionOptions });
    await events.waitUntilReady();
    const worker = new Worker(
      queue.name,
      async (job) => {
        if (job.data.fail) throw new Error("planned failure");
      },
      { connection: shared },
    );
    cleanups.push(
      () => worker.close(),
      () => events.close(),
      () => eventsConnection.quit(),
      () => queue.obliterate({ force: true }),
      () => queue.close(),
    );

    /** Adds a job and waits until it has completed or finally failed. */
    const run = async (data: Record<string, unknown> = {}) => {
      const job = await queue.add("execute-code", data);
      await job.waitUntilFinished(events).catch(() => undefined);
      return job.id!;
    };
    return { queue, run };
  }

  it("applies the execution retention options to every job and keeps recent finished jobs for debugging", async () => {
    const { queue, run } = await testQueue(EXECUTION_JOB_OPTIONS);
    const completed = await run();
    const failed = await run({ fail: true });

    const completedJob = await queue.getJob(completed);
    assert.deepEqual(completedJob?.opts.removeOnComplete, COMPLETED_JOB_RETENTION);
    assert.deepEqual(completedJob?.opts.removeOnFail, FAILED_JOB_RETENTION);
    assert.equal(await queue.getJobState(completed), "completed");
    assert.equal(await queue.getJobState(failed), "failed", "a final failure is kept");
    assert.equal((await queue.getJob(failed))?.failedReason, "planned failure");
  });

  it("keeps at most `count` completed jobs, removing the oldest", async () => {
    const { queue, run } = await testQueue({ ...EXECUTION_JOB_OPTIONS, removeOnComplete: { ...COMPLETED_JOB_RETENTION, count: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await run());

    assert.equal(await queue.getCompletedCount(), 2);
    assert.deepEqual(await Promise.all(ids.map((id) => queue.getJobState(id))), ["unknown", "unknown", "unknown", "completed", "completed"]);
  });

  it("keeps at most `count` failed jobs, removing the oldest", async () => {
    const { queue, run } = await testQueue({ ...EXECUTION_JOB_OPTIONS, attempts: 1, removeOnFail: { ...FAILED_JOB_RETENTION, count: 1 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await run({ fail: true }));

    assert.equal(await queue.getFailedCount(), 1);
    assert.equal(await queue.getJobState(ids[2]), "failed");
  });

  it("removes completed jobs older than `age` when a later job finishes", async () => {
    const { queue, run } = await testQueue({ ...EXECUTION_JOB_OPTIONS, removeOnComplete: { age: 1, count: 1000 } });
    const old = await run();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const recent = await run();

    assert.equal(await queue.getJobState(old), "unknown");
    assert.equal(await queue.getJobState(recent), "completed");
  });

  it("never lets the reconciler change a finished execution whose job was removed", async () => {
    const { queue, run } = await testQueue({ ...EXECUTION_JOB_OPTIONS, removeOnComplete: { ...COMPLETED_JOB_RETENTION, count: 1 } });
    const createdAt = new Date(Date.now() - 60 * 60 * 1000);
    const finishedId = `finished-${randomUUID()}`;
    const rows = new Map<string, StaleExecution & { output: string | null }>([
      [finishedId, { id: finishedId, status: "COMPLETED", createdAt, output: "42" }],
    ]);

    // The finished execution's job completes and is then pushed out by a newer one.
    await queue.add("execute-code", {}, { jobId: finishedId });
    await new Promise<void>((resolve) => {
      const check = async () => ((await queue.getJobState(finishedId)) === "completed" ? resolve() : setTimeout(check, 50));
      void check();
    });
    await run();
    assert.equal(await queue.getJobState(finishedId), "unknown", "the job was removed by retention");

    const store: ReconcileStore = {
      findMany: async ({ where }) => [...rows.values()].filter((r) => where.status.in.includes(r.status) && r.createdAt < where.createdAt.lt),
      updateMany: async ({ where, data }) => {
        const r = rows.get(where.id);
        if (!r || r.status !== where.status) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    };
    const summary = await reconcileOrphanedExecutions({ store, queue, graceMs: 5 * 60 * 1000, logger: silent });

    assert.equal(summary.markedFailed, 0);
    assert.deepEqual(rows.get(finishedId), { id: finishedId, status: "COMPLETED", createdAt, output: "42" });
  });
});
