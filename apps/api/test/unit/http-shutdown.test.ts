// Real HTTP servers on ephemeral local ports; no database, queue or Redis is involved.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { closeHttpServer } from "../../src/lib/http-shutdown.js";

/** A server whose /slow/<ms> responds after the given delay, and which reports when a request has started. */
async function startServer() {
  let onRequestStarted = () => {};
  const server = http.createServer((req, res) => {
    onRequestStarted();
    const delay = Number(req.url?.split("/")[2] ?? 0);
    setTimeout(() => res.end("done"), delay);
  });
  server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const requestStarted = () => new Promise<void>((resolve) => (onRequestStarted = resolve));
  return { server, port, requestStarted };
}

function get(port: number, path: string, agent?: http.Agent) {
  return new Promise<{ status: number; body: string; connection: string | undefined }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }));
      })
      .on("error", reject);
  });
}

describe("closeHttpServer", () => {
  it("lets an in-flight request finish and then resolves", async () => {
    const { server, port, requestStarted } = await startServer();
    const started = requestStarted();
    const inFlight = get(port, "/slow/200");
    await started;

    const closing = closeHttpServer(server, 5000);
    const response = await inFlight;
    assert.deepEqual({ status: response.status, body: response.body }, { status: 200, body: "done" });
    await closing;
    assert.equal(server.listening, false);
  });

  it("refuses new connections once closing has started", async () => {
    const { server, port, requestStarted } = await startServer();
    const started = requestStarted();
    const inFlight = get(port, "/slow/300");
    await started;

    const closing = closeHttpServer(server, 5000);
    await assert.rejects(get(port, "/slow/0"), /ECONNREFUSED/);
    await inFlight;
    await closing;
  });

  it("does not wait for idle keep-alive connections", async () => {
    const { server, port } = await startServer();
    const agent = new http.Agent({ keepAlive: true });
    await get(port, "/slow/0", agent); // leaves an idle keep-alive socket open

    const started = Date.now();
    await closeHttpServer(server, 5000);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
    agent.destroy();
  });

  it("closes a keep-alive connection right after its in-flight request finishes", async () => {
    const { server, port, requestStarted } = await startServer();
    const agent = new http.Agent({ keepAlive: true });
    const started = requestStarted();
    const inFlight = get(port, "/slow/200", agent);
    await started;

    const begun = Date.now();
    await closeHttpServer(server, 5000);
    await inFlight;
    assert.ok(Date.now() - begun < 1500, `took ${Date.now() - begun}ms`);
    agent.destroy();
  });

  it("destroys remaining connections and rejects when requests outlast the timeout", async () => {
    const { server, port, requestStarted } = await startServer();
    const started = requestStarted();
    const inFlight = get(port, "/slow/5000");
    await started;

    await assert.rejects(closeHttpServer(server, 100), /in-flight requests did not finish within 100ms; remaining connections were closed/);
    await assert.rejects(inFlight, /socket hang up|ECONNRESET/);
    assert.equal(server.listening, false);
  });

  it("rejects when the server is not running", async () => {
    const server = http.createServer();
    await assert.rejects(closeHttpServer(server, 1000), /not running/i);
  });
});
