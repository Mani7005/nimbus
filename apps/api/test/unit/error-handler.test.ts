// HTTP-level test of the final error handler on a minimal Express app; no database, queue or Redis is involved.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { INTERNAL_ERROR_MESSAGE, errorHandler, notFoundHandler } from "../../src/middleware/error.middleware.js";

const SECRET_DETAIL = "relation \"Execution\" does not exist at postgresql://postgres:hunter2@db";
const logged: unknown[][] = [];
const logger = { error: (...args: unknown[]) => void logged.push(args) };

const app = express();
app.use(express.json({ limit: "64b" }));
app.get("/sync", () => {
  throw new Error(SECRET_DETAIL);
});
app.get("/async", async () => {
  await Promise.resolve();
  throw Object.assign(new Error(SECRET_DETAIL), { code: "P2021" });
});
app.get("/non-error", async () => {
  throw "plain string failure";
});
app.get("/partial", (_req, res, next) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.write("partial");
  next(new Error(SECRET_DETAIL));
});
app.post("/echo", (req, res) => void res.json({ success: true, body: req.body }));
app.use(notFoundHandler);
app.use(errorHandler(logger));

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  logged.length = 0;
});

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text };
}

function assertNoInternals(text: string) {
  assert.doesNotMatch(text, /hunter2|does not exist|\n\s+at |SyntaxError|Error:/);
}

describe("errorHandler", () => {
  it("answers malformed JSON with a fixed 400 JSON message that does not echo the body", async () => {
    const { status, contentType, text } = await request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"code": hunter2',
    });
    assert.equal(status, 400);
    assert.match(contentType, /application\/json/);
    assert.deepEqual(JSON.parse(text), { success: false, message: "Malformed JSON request body" });
    assertNoInternals(text);
    assert.equal(logged.length, 0, "client errors are not logged as server errors");
  });

  it("answers an oversized body with 413 JSON", async () => {
    const { status, text } = await request("/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(200) }),
    });
    assert.equal(status, 413);
    assert.deepEqual(JSON.parse(text), { success: false, message: "Request body too large" });
  });

  for (const path of ["/sync", "/async"]) {
    it(`answers an unexpected error from ${path} with a generic 500 and logs the real error`, async () => {
      const { status, contentType, text } = await request(path);
      assert.equal(status, 500);
      assert.match(contentType, /application\/json/);
      assert.deepEqual(JSON.parse(text), { success: false, message: INTERNAL_ERROR_MESSAGE });
      assertNoInternals(text);

      assert.equal(logged.length, 1);
      assert.equal(logged[0][0], `Unhandled error on GET ${path}:`);
      assert.equal((logged[0][1] as Error).message, SECRET_DETAIL);
    });
  }

  it("handles non-Error throws", async () => {
    const { status, text } = await request("/non-error");
    assert.equal(status, 500);
    assert.deepEqual(JSON.parse(text), { success: false, message: INTERNAL_ERROR_MESSAGE });
    assert.equal(logged[0][1], "plain string failure");
  });

  it("does not log the query string, which may hold credentials", async () => {
    await request("/sync?token=abc123");
    assert.equal(logged[0][0], "Unhandled error on GET /sync:");
  });

  it("logs an error after the response started and lets Express end the connection instead of crashing", async () => {
    await assert.rejects(request("/partial"), "the truncated response is aborted");
    assert.equal(logged.length, 1);
    // The server is still healthy afterwards.
    assert.equal((await request("/echo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 200);
  });
});

describe("notFoundHandler", () => {
  it("answers unknown routes with 404 JSON", async () => {
    const { status, contentType, text } = await request("/does-not-exist");
    assert.equal(status, 404);
    assert.match(contentType, /application\/json/);
    assert.deepEqual(JSON.parse(text), { success: false, message: "Route not found" });
  });
});
