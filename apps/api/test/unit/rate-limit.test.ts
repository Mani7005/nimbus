// Mocked: the stores use a fake clock and a fake Redis client; see test/integration for the real Redis store.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { MemoryRateLimitStore, RedisRateLimitStore, rateLimit, type RateLimitStore } from "../../src/middleware/rate-limit.middleware.js";

describe("MemoryRateLimitStore", () => {
  it("counts hits per key within a fixed window and resets after it", async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore(() => now);

    assert.deepEqual(await store.hit("a", 1000), { count: 1, resetMs: 1000 });
    now += 400;
    assert.deepEqual(await store.hit("a", 1000), { count: 2, resetMs: 600 });
    assert.deepEqual(await store.hit("b", 1000), { count: 1, resetMs: 1000 }, "keys are independent");
    now += 600;
    assert.deepEqual(await store.hit("a", 1000), { count: 1, resetMs: 1000 }, "a new window starts exactly at the reset time");
  });

  it("stays bounded by dropping the oldest keys", async () => {
    const store = new MemoryRateLimitStore(() => 0, 3);
    for (const key of ["a", "b", "c", "d", "e"]) await store.hit(key, 60_000);
    assert.equal(store.size, 3);
    assert.equal((await store.hit("e", 60_000)).count, 2, "the newest key keeps its count");
  });

  it("sweeps expired windows", async () => {
    let now = 0;
    const store = new MemoryRateLimitStore(() => now);
    await store.hit("a", 1000);
    await store.hit("b", 1000);
    now = 61_000;
    await store.hit("c", 1000);
    assert.equal(store.size, 1);
  });
});

describe("RedisRateLimitStore", () => {
  it("runs one atomic script per hit with a prefixed key and the window", async () => {
    const calls: unknown[][] = [];
    const store = new RedisRateLimitStore({ eval: async (...args) => (calls.push(args), [3, 4200]) }, "test:");
    assert.deepEqual(await store.hit("login:1.2.3.4", 60_000), { count: 3, resetMs: 4200 });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0][0]), /INCR/);
    assert.deepEqual(calls[0].slice(1), [1, "test:login:1.2.3.4", 60_000]);
  });
});

describe("rateLimit middleware", () => {
  let now = 0;
  const logged: string[] = [];
  const logger = { error: (line: string) => void logged.push(line) };
  let failingStore: RateLimitStore = { hit: async () => assert.fail("replaced per test") };

  const app = express();
  const limiter = (store: RateLimitStore, timeoutMs = 1000) =>
    rateLimit({ name: "t", max: 2, windowMs: 1000, message: "Slow down.", key: (req) => req.get("x-client"), store, timeoutMs, logger });
  app.get("/limited", limiter(new MemoryRateLimitStore(() => now)), (_req, res) => void res.json({ success: true }));
  app.get("/failing", (req, res, next) => void limiter(failingStore, 50)(req, res, next), (_req, res) => void res.json({ success: true }));

  let server: ReturnType<typeof app.listen>;
  let baseUrl = "";
  before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  async function get(path: string, client?: string) {
    const response = await fetch(`${baseUrl}${path}`, { headers: client ? { "x-client": client } : {} });
    return { status: response.status, retryAfter: response.headers.get("retry-after"), type: response.headers.get("content-type"), body: await response.json() };
  }

  it("allows up to the limit, then answers 429 JSON with Retry-After, and resets after the window", async () => {
    now = 10_000;
    assert.equal((await get("/limited", "alice")).status, 200);
    assert.equal((await get("/limited", "alice")).status, 200);

    now += 300;
    const limited = await get("/limited", "alice");
    assert.equal(limited.status, 429);
    assert.match(limited.type ?? "", /application\/json/);
    assert.deepEqual(limited.body, { success: false, message: "Slow down." });
    assert.equal(limited.retryAfter, "1");

    assert.equal((await get("/limited", "bob")).status, 200, "another client is unaffected");

    now += 700;
    assert.equal((await get("/limited", "alice")).status, 200, "allowed again once the window has passed");
  });

  it("does not limit requests without a client key", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await get("/limited")).status, 200);
  });

  it("allows the request and logs when the store fails", async () => {
    logged.length = 0;
    failingStore = { hit: async () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")) };
    assert.equal((await get("/failing", "alice")).status, 200);
    assert.match(logged[0], /Rate limiter "t" unavailable, allowing request: ECONNREFUSED/);
  });

  it("allows the request and logs when the store hangs past the timeout", async () => {
    logged.length = 0;
    failingStore = { hit: () => new Promise(() => undefined) };
    assert.equal((await get("/failing", "alice")).status, 200);
    assert.match(logged[0], /did not respond within 50ms/);
  });
});
