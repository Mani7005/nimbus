// HTTP-level test of the CORS policy on an ephemeral local port.
// Mocked: Prisma and the BullMQ queue are in-memory fakes; no Postgres or Redis is used.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";

const ALLOWED = "https://app.example.com";
const ALSO_ALLOWED = "http://localhost:5173";
const OTHER = "https://evil.example.net";
process.env.CORS_ORIGINS = `${ALLOWED}, ${ALSO_ALLOWED}`;

mock.module("../../src/lib/prisma.js", { defaultExport: {} });
mock.module("../../src/queues/execution.queue.js", { namedExports: { executionQueue: { add: async () => undefined } } });

const { default: app } = await import("../../src/app.js");

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function request(method: string, path: string, headers: Record<string, string>) {
  return fetch(`${baseUrl}${path}`, { method, headers });
}

function preflight(origin: string) {
  return request("OPTIONS", "/execute", {
    Origin: origin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type",
  });
}

describe("CORS", () => {
  for (const origin of [ALLOWED, ALSO_ALLOWED]) {
    it(`allows the configured origin ${origin} without credentials`, async () => {
      const response = await request("GET", "/health", { Origin: origin });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.match(response.headers.get("vary") ?? "", /Origin/);
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
    });
  }

  it("answers a preflight from an allowed origin for an authenticated JSON POST", async () => {
    const response = await preflight(ALLOWED);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ALLOWED);
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /authorization/i);
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
  });

  for (const origin of [OTHER, "null", `${ALLOWED}.evil.example.net`, "https://app.example.com:8443", "http://app.example.com"]) {
    it(`never allows the unlisted origin ${origin}`, async () => {
      for (const response of [await request("GET", "/health", { Origin: origin }), await preflight(origin)]) {
        assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
    });
  }

  it("never answers with a wildcard origin", async () => {
    for (const origin of [ALLOWED, OTHER]) {
      const response = await request("GET", "/health", { Origin: origin });
      assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
    }
    const withoutOrigin = await request("GET", "/health", {});
    assert.equal(withoutOrigin.headers.get("access-control-allow-origin"), null);
  });
});
