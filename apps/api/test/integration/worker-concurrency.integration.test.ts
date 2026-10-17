// REAL Redis + BullMQ: skipped unless NIMBUS_REDIS_INTEGRATION=1. Uses REDIS_URL from the environment or apps/api/.env.
// Each run uses a throwaway queue name that is obliterated afterwards; the execution queue is never touched.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";

const enabled = process.env.NIMBUS_REDIS_INTEGRATION === "1";

/** Runs `jobs` jobs that each take ~150ms and returns the most that were ever in progress at once. */
async function peakInFlight(concurrency: number, jobs: number): Promise<number> {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }) as unknown as ConnectionOptions;
  const queue = new Queue(`nimbus-test-${randomUUID()}`, { connection });
  let inFlight = 0;
  let peak = 0;
  let done = 0;
  let worker: Worker | undefined;
  try {
    const finished = new Promise<void>((resolve) => {
      worker = new Worker(
        queue.name,
        async () => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 150));
          inFlight--;
          if (++done === jobs) resolve();
        },
        { connection, concurrency },
      );
    });
    await queue.addBulk(Array.from({ length: jobs }, (_, i) => ({ name: "job", data: { i } })));
    await finished;
    return peak;
  } finally {
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await (connection as unknown as Redis).quit();
  }
}

describe("worker concurrency with real BullMQ", { skip: enabled ? false : "set NIMBUS_REDIS_INTEGRATION=1 to run", timeout: 30000 }, () => {
  it("processes one job at a time with concurrency 1", async () => {
    assert.equal(await peakInFlight(1, 4), 1);
  });

  it("never exceeds the configured concurrency", async () => {
    assert.equal(await peakInFlight(2, 6), 2);
  });
});
