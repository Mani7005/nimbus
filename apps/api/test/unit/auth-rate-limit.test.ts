// HTTP-level test of the per-IP login and registration limits on the real app (in-memory store, see test.env).
// Mocked: Prisma, the BullMQ queue and bcrypt are in-memory fakes; no Postgres or Redis is used.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";

process.env.AUTH_LOGIN_RATE_LIMIT = "3";
process.env.AUTH_LOGIN_RATE_WINDOW_MS = "1000";
process.env.AUTH_REGISTER_RATE_LIMIT = "2";
process.env.AUTH_REGISTER_RATE_WINDOW_MS = "60000";

const users: { id: string; email: string; password: string }[] = [];
const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null,
    create: async ({ data }: { data: { email: string; password: string } }) => {
      const user = { id: `user-${users.length + 1}`, ...data };
      users.push(user);
      return user;
    },
  },
  execution: {},
};

mock.module("../../src/lib/prisma.js", { defaultExport: fakePrisma });
mock.module("../../src/queues/execution.queue.js", { namedExports: { executionQueue: { add: async () => undefined } } });
mock.module("bcrypt", { defaultExport: { hash: async (p: string) => `hashed:${p}`, compare: async (p: string, h: string) => h === `hashed:${p}` } });

const { default: app } = await import("../../src/app.js");
const { LOGIN_RATE_LIMIT_MESSAGE, REGISTER_RATE_LIMIT_MESSAGE } = await import("../../src/middleware/rate-limiters.js");

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, type: response.headers.get("content-type"), retryAfter: response.headers.get("retry-after"), body: await response.json() };
}

describe("login rate limit", () => {
  it("allows 3 attempts per IP, then returns 429 JSON, even for valid credentials, and resets after the window", async () => {
    users.push({ id: "seed", email: "kim@example.com", password: "hashed:right-password" });

    assert.equal((await post("/login", { email: "kim@example.com", password: "wrong" })).status, 401);
    assert.equal((await post("/login", { email: "not-an-email", password: "x" })).status, 400, "malformed attempts count too");
    assert.equal((await post("/login", { email: "kim@example.com", password: "wrong" })).status, 401);

    const limited = await post("/login", { email: "kim@example.com", password: "right-password" });
    assert.equal(limited.status, 429);
    assert.match(limited.type ?? "", /application\/json/);
    assert.deepEqual(limited.body, { success: false, message: LOGIN_RATE_LIMIT_MESSAGE });
    assert.equal(limited.retryAfter, "1");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await post("/login", { email: "kim@example.com", password: "right-password" })).status, 200, "allowed after the window");
  });
});

describe("registration rate limit", () => {
  it("counts separately from login and returns 429 JSON after 2 attempts per IP", async () => {
    assert.equal((await post("/register", { email: "r1@example.com", password: "password123" })).status, 201);
    assert.equal((await post("/register", { email: "r2@example.com", password: "password123" })).status, 201);

    const limited = await post("/register", { email: "r3@example.com", password: "password123" });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { success: false, message: REGISTER_RATE_LIMIT_MESSAGE });
    assert.ok(Number(limited.retryAfter) > 1 && Number(limited.retryAfter) <= 60);
    assert.ok(!users.some((u) => u.email === "r3@example.com"), "the limited request created no account");
  });
});
