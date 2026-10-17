// REAL Redis: skipped unless NIMBUS_REDIS_INTEGRATION=1. Uses REDIS_URL from the environment or apps/api/.env.
// Every key lives under a random nimbus-test: prefix and is deleted afterwards; no queue is touched.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Redis } from "ioredis";
import { env } from "../../src/config/env.js";
import { RedisRateLimitStore } from "../../src/middleware/rate-limit.middleware.js";

const enabled = process.env.NIMBUS_REDIS_INTEGRATION === "1";

describe("RedisRateLimitStore with real Redis", { skip: enabled ? false : "set NIMBUS_REDIS_INTEGRATION=1 to run", timeout: 30000 }, () => {
  const prefix = `nimbus-test:ratelimit:${randomUUID()}:`;
  let redis: Redis;
  let store: RedisRateLimitStore;

  before(() => {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
    store = new RedisRateLimitStore(redis, prefix);
  });

  after(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it("counts within the window and starts a new window after it expires", async () => {
    const first = await store.hit("login:1.2.3.4", 400);
    assert.equal(first.count, 1);
    assert.ok(first.resetMs > 0 && first.resetMs <= 400);
    assert.equal((await store.hit("login:1.2.3.4", 400)).count, 2);
    assert.equal((await store.hit("login:5.6.7.8", 400)).count, 1, "keys are independent");

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await store.hit("login:1.2.3.4", 400)).count, 1);
  });

  it("increments atomically under concurrent hits", async () => {
    const hits = await Promise.all(Array.from({ length: 25 }, () => store.hit("burst", 10_000)));
    assert.deepEqual(hits.map((h) => h.count).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("always leaves an expiry on the key", async () => {
    await store.hit("expiry", 10_000);
    const ttl = await redis.pttl(`${prefix}expiry`);
    assert.ok(ttl > 0 && ttl <= 10_000, `ttl ${ttl}`);
  });
});
