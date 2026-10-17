// HTTP-level test of /auth and the authentication middleware on an ephemeral local port.
// Mocked: Prisma, the BullMQ queue and bcrypt are in-memory fakes; no Postgres or Redis is used.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it, mock } from "node:test";

// This file checks auth behaviour, not limits (see auth-rate-limit.test.ts), so the per-IP limits are raised.
process.env.AUTH_LOGIN_RATE_LIMIT = "10000";
process.env.AUTH_REGISTER_RATE_LIMIT = "10000";

interface StoredUser {
  id: string;
  email: string;
  password: string;
  createdAt: Date;
}

const users: StoredUser[] = [];
const prismaCalls: string[] = [];
const compareCalls: { password: string; hash: string }[] = [];
let createFailure: Error | undefined;
let raceOnCreate = false;

// Mirrors the database: emails are unique and compared exactly (case-sensitively).
const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
      prismaCalls.push("user.findUnique");
      const user = users.find((u) => (where.email !== undefined ? u.email === where.email : u.id === where.id));
      return user ? { ...user } : null;
    },
    create: async ({ data }: { data: { email: string; password: string } }) => {
      prismaCalls.push("user.create");
      if (createFailure) throw createFailure;
      if (raceOnCreate || users.some((u) => u.email === data.email)) {
        throw Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { code: "P2002" });
      }
      const user = { id: `user-${users.length + 1}`, createdAt: new Date(), ...data };
      users.push(user);
      return { ...user };
    },
  },
  execution: {},
};

const fakeBcrypt = {
  hash: async (password: string) => `hashed:${password}`,
  compare: async (password: string, hash: string) => {
    compareCalls.push({ password, hash });
    return hash === `hashed:${password}`;
  },
};

mock.module("../../src/lib/prisma.js", { defaultExport: fakePrisma });
mock.module("../../src/queues/execution.queue.js", { namedExports: { executionQueue: { add: async () => undefined } } });
mock.module("bcrypt", { defaultExport: fakeBcrypt });

const { default: app } = await import("../../src/app.js");
const { env } = await import("../../src/config/env.js");
const { generateToken } = await import("../../src/utils/jwt.js");
const { default: jwt } = await import("jsonwebtoken");

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  users.length = 0;
  prismaCalls.length = 0;
  compareCalls.length = 0;
  createFailure = undefined;
  raceOnCreate = false;
});

type Json = { success: boolean; message?: string; token?: string; user?: { id: string; email: string } | null };

async function post(path: string, body: unknown, rawBody?: string) {
  const response = await fetch(`${baseUrl}/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody ?? JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function getMe(authorization?: string) {
  const response = await fetch(`${baseUrl}/auth/me`, { headers: authorization === undefined ? {} : { Authorization: authorization } });
  return { status: response.status, body: (await response.json()) as Json };
}

function seedUser(email: string, password: string): StoredUser {
  const user = { id: `seed-${users.length + 1}`, email, password: `hashed:${password}`, createdAt: new Date() };
  users.push(user);
  return user;
}

describe("POST /auth/login validation", () => {
  for (const [name, body] of [
    ["an empty object", {}],
    ["a missing password", { email: "a@example.com" }],
    ["a non-string email", { email: { $ne: "" }, password: "password123" }],
    ["a non-string password", { email: "a@example.com", password: 12345678 }],
    ["an invalid email", { email: "not-an-email", password: "password123" }],
    ["an empty password", { email: "a@example.com", password: "" }],
    ["an array body", [{ email: "a@example.com", password: "password123" }]],
  ] as const) {
    it(`returns 400 for ${name} without querying the database`, async () => {
      const { status, body: response } = await post("/login", body);
      assert.equal(status, 400);
      assert.equal(response.success, false);
      assert.equal(typeof response.message, "string");
      assert.deepEqual(prismaCalls, []);
    });
  }

  it("returns 400 JSON when the body is missing entirely", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, { method: "POST" });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as Json).success, false);
    assert.deepEqual(prismaCalls, []);
  });
});

describe("email normalization", () => {
  it("stores a trimmed, lower-cased email and accepts login with any casing", async () => {
    const registered = await post("/register", { email: "  Alice@Example.COM ", password: "correct horse" });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.user?.email, "alice@example.com");
    assert.deepEqual(users.map((u) => u.email), ["alice@example.com"]);

    const loggedIn = await post("/login", { email: "ALICE@example.com  ", password: "correct horse" });
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.user?.email, "alice@example.com");
    assert.equal(typeof loggedIn.body.token, "string");
  });
});

describe("password byte limit", () => {
  const emoji = "\u{1F600}"; // 4 UTF-8 bytes, 2 UTF-16 code units

  it("rejects a password of 19 emoji: 76 bytes but only 38 UTF-16 characters", async () => {
    const password = emoji.repeat(19);
    assert.ok(password.length < 72);
    const { status, body } = await post("/register", { email: "e@example.com", password });
    assert.equal(status, 400);
    assert.equal(body.message, "password: Password must be at most 72 bytes");
    assert.deepEqual(prismaCalls, []);
  });

  it("accepts a password of exactly 72 bytes", async () => {
    const { status } = await post("/register", { email: "e@example.com", password: emoji.repeat(18) });
    assert.equal(status, 201);
  });

  it("rejects 73 ASCII characters", async () => {
    const { status } = await post("/register", { email: "e@example.com", password: "a".repeat(73) });
    assert.equal(status, 400);
  });

  it("still lets an older account log in with a password longer than 72 bytes", async () => {
    const legacyPassword = emoji.repeat(30);
    seedUser("legacy@example.com", legacyPassword);
    const { status } = await post("/login", { email: "legacy@example.com", password: legacyPassword });
    assert.equal(status, 200);
  });
});

describe("POST /auth/register errors", () => {
  it("returns 409 with a generic message for a duplicate email in any casing, without inserting", async () => {
    seedUser("bob@example.com", "password123");
    const { status, body } = await post("/register", { email: "BOB@example.com", password: "another-pass" });

    assert.equal(status, 409);
    assert.deepEqual(body, { success: false, message: "An account with this email already exists" });
    assert.ok(!prismaCalls.includes("user.create"));
  });

  it("returns the same 409 when a concurrent registration wins the race (Prisma P2002)", async () => {
    raceOnCreate = true;
    const { status, body } = await post("/register", { email: "race@example.com", password: "password123" });

    assert.equal(status, 409);
    assert.deepEqual(body, { success: false, message: "An account with this email already exists" });
    assert.deepEqual(prismaCalls, ["user.findUnique", "user.create"], "the lookup found nothing; the insert lost the race");
  });

  it("returns a generic 500 for any other failure without leaking it", async () => {
    createFailure = new Error("Can't reach database server at db:5432");
    const { status, body } = await post("/register", { email: "c@example.com", password: "password123" });

    assert.equal(status, 500);
    assert.deepEqual(body, { success: false, message: "Internal server error" });
  });
});

describe("generic login failure", () => {
  it("responds identically to an unknown email and a wrong password", async () => {
    seedUser("dana@example.com", "right-password");
    const unknown = await post("/login", { email: "nobody@example.com", password: "right-password" });
    const wrong = await post("/login", { email: "dana@example.com", password: "wrong-password" });

    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown, wrong);
    assert.deepEqual(unknown.body, { success: false, message: "Invalid email or password" });
  });

  it("runs a bcrypt comparison for unknown emails too, so both paths take similar time", async () => {
    await post("/login", { email: "nobody@example.com", password: "whatever-password" });
    assert.equal(compareCalls.length, 1);
    assert.equal(compareCalls[0].password, "whatever-password");
  });
});

describe("authenticate middleware", () => {
  const token = generateToken("user-42");

  it("accepts a valid Bearer token, with the scheme in any case", async () => {
    seedUser("x@example.com", "password123");
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const { status } = await getMe(`${scheme} ${token}`);
      assert.equal(status, 200, scheme);
    }
  });

  it("returns 401 Token missing without an Authorization header", async () => {
    assert.deepEqual(await getMe(), { status: 401, body: { success: false, message: "Token missing" } });
  });

  const malformed: [string, () => string][] = [
    ["a bare token", () => token],
    ["the Basic scheme", () => `Basic ${token}`],
    ["Bearer with no token", () => "Bearer"],
    ["Bearer with only a space", () => "Bearer "],
    ["two spaces", () => `Bearer  ${token}`],
    ["trailing data", () => `Bearer ${token} extra`],
    ["a second token", () => `Bearer ${token}, Bearer ${token}`],
    ["a non-JWT value", () => "Bearer abc.def"],
    ["an unsigned alg=none token", () => {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return `Bearer ${encode({ alg: "none", typ: "JWT" })}.${encode({ userId: "user-42" })}.`;
    }],
    ["a token signed with another secret", () => `Bearer ${jwt.sign({ userId: "user-42" }, "x".repeat(40))}`],
    ["a token signed with HS512", () => `Bearer ${jwt.sign({ userId: "user-42" }, env.JWT_SECRET, { algorithm: "HS512" })}`],
    ["an expired token", () => `Bearer ${jwt.sign({ userId: "user-42", exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET)}`],
    ["a token without a userId", () => `Bearer ${jwt.sign({ sub: "user-42" }, env.JWT_SECRET)}`],
    ["a token with a non-string userId", () => `Bearer ${jwt.sign({ userId: 42 }, env.JWT_SECRET)}`],
  ];

  for (const [name, header] of malformed) {
    it(`returns 401 Invalid token for ${name}`, async () => {
      assert.deepEqual(await getMe(header()), { status: 401, body: { success: false, message: "Invalid token" } });
      assert.deepEqual(prismaCalls, [], "rejected before any database access");
    });
  }
});
