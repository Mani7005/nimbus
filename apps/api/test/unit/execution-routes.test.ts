// HTTP-level test of the /execute routes on an ephemeral local port.
// Mocked: Prisma and the BullMQ queue are in-memory fakes; no Postgres or Redis is used.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it, mock } from "node:test";

process.env.JWT_SECRET = "nimbus-test-secret-at-least-32-characters";

const VALID_ID = "cmrm5whp00000ieqonyoqlbge";
const prismaCalls: string[] = [];
const queued: unknown[] = [];

const fakePrisma = {
  // The per-user limit transaction: lock, count (always 0 here), then create.
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakePrisma),
  $executeRaw: async () => 1,
  execution: {
    count: async () => 0,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      prismaCalls.push("create");
      return { id: VALID_ID, ...data };
    },
    findFirst: async () => {
      prismaCalls.push("findFirst");
      return null;
    },
    deleteMany: async () => {
      prismaCalls.push("deleteMany");
      return { count: 0 };
    },
    findMany: async () => [],
  },
};

mock.module("../../src/lib/prisma.js", { defaultExport: fakePrisma });
mock.module("../../src/queues/execution.queue.js", {
  namedExports: { executionQueue: { add: async (_name: string, data: unknown) => void queued.push(data) } },
});

const { default: app } = await import("../../src/app.js");
const { generateToken } = await import("../../src/utils/jwt.js");
const { MAX_CODE_LENGTH } = await import("../../src/validators/execution.validator.js");

let server: ReturnType<typeof app.listen>;
let baseUrl = "";
const token = generateToken("user-1");

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  prismaCalls.length = 0;
  queued.length = 0;
});

async function call(method: string, path: string, body?: unknown, auth = true) {
  const response = await fetch(`${baseUrl}/execute${path}`, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { success: boolean; message?: string; execution?: unknown } };
}

describe("POST /execute validation", () => {
  it("accepts a valid request with the existing 201 response", async () => {
    const { status, body } = await call("POST", "/", { language: "cpp", code: "int main() {}", input: "1" });
    assert.equal(status, 201);
    assert.equal(body.success, true);
    assert.deepEqual(body.execution, { id: VALID_ID, language: "cpp", code: "int main() {}", input: "1", userId: "user-1", status: "PENDING" });
    assert.deepEqual(queued, [{ executionId: VALID_ID }]);
  });

  it("still defaults a missing input to an empty string", async () => {
    const { status, body } = await call("POST", "/", { language: "cpp", code: "int main() {}" });
    assert.equal(status, 201);
    assert.equal((body.execution as { input: string }).input, "");
  });

  for (const [name, payload] of [
    ["missing code", { language: "cpp" }],
    ["incorrect type", { language: "cpp", code: 123 }],
    ["oversized code", { language: "cpp", code: "x".repeat(MAX_CODE_LENGTH + 1) }],
  ] as const) {
    it(`returns 400 for ${name} without touching the database or queue`, async () => {
      const { status, body } = await call("POST", "/", payload);
      assert.equal(status, 400);
      assert.equal(body.success, false);
      assert.match(body.message ?? "", /^code: /);
      assert.deepEqual(prismaCalls, []);
      assert.deepEqual(queued, []);
    });
  }

  it("accepts a Java request with the same 201 response and queue payload", async () => {
    const code = "public class Main { public static void main(String[] a) {} }";
    const { status, body } = await call("POST", "/", { language: "java", code, input: "" });
    assert.equal(status, 201);
    assert.deepEqual(body.execution, { id: VALID_ID, language: "java", code, input: "", userId: "user-1", status: "PENDING" });
    assert.deepEqual(prismaCalls, ["create"]);
    assert.deepEqual(queued, [{ executionId: VALID_ID }]);
  });

  for (const [name, language] of [
    ["python", "python"],
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
    ["an empty language", ""],
    ["a differently cased language", "CPP"],
    ["a non-string language", 7],
    ["an array language", ["java"]],
  ] as const) {
    it(`returns 400 for ${name} without touching the database or queue`, async () => {
      const { status, body } = await call("POST", "/", { language, code: "int main() {}" });
      assert.equal(status, 400);
      assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
      assert.equal(body.success, false);
      assert.match(body.message ?? "", /^language: /);
      assert.deepEqual(prismaCalls, []);
      assert.deepEqual(queued, []);
    });
  }

  it("returns 400 for a missing language without touching the database or queue", async () => {
    const { status, body } = await call("POST", "/", { code: "int main() {}" });
    assert.equal(status, 400);
    assert.match(body.message ?? "", /^language: /);
    assert.deepEqual(prismaCalls, []);
    assert.deepEqual(queued, []);
  });

  it("returns 400 when no JSON body is sent", async () => {
    const { status, body } = await call("POST", "/");
    assert.equal(status, 400);
    assert.equal(body.success, false);
  });

  it("authenticates before validating", async () => {
    const { status } = await call("POST", "/", { language: "cpp" }, false);
    assert.equal(status, 401);
  });
});

describe("app error handling", () => {
  it("answers malformed JSON on POST /execute with 400 JSON and no stack trace", async () => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: '{"language": "cpp", "code": ',
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(text), { success: false, message: "Malformed JSON request body" });
    assert.doesNotMatch(text, /\n\s+at |SyntaxError/);
    assert.deepEqual(prismaCalls, []);
  });

  it("answers unknown routes with 404 JSON", async () => {
    const response = await fetch(`${baseUrl}/no-such-route`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { success: false, message: "Route not found" });
  });
});

describe("GET and DELETE /execute/:id validation", () => {
  for (const method of ["GET", "DELETE"]) {
    it(`${method} returns 400 for a malformed id without touching the database`, async () => {
      const { status, body } = await call(method, "/not-a-cuid");
      assert.equal(status, 400);
      assert.deepEqual(body, { success: false, message: "id: Invalid execution id" });
      assert.deepEqual(prismaCalls, []);
    });

    it(`${method} passes a well-formed id through to the existing 404`, async () => {
      const { status, body } = await call(method, `/${VALID_ID}`);
      assert.equal(status, 404);
      assert.deepEqual(body, { success: false, message: "Execution not found" });
      assert.equal(prismaCalls.length, 1);
    });
  }
});
