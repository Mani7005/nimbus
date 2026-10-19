import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  CLEAN_SHUTDOWN_MESSAGE,
  exitOnShutdownSignal,
  runShutdownSteps,
  shutdownSignals,
  type ShutdownStep,
} from "../../src/lib/shutdown.js";

function recordingLogger() {
  const entries: { level: string; line: string }[] = [];
  return {
    entries,
    logger: {
      log: (line: string) => void entries.push({ level: "log", line }),
      error: (line: string) => void entries.push({ level: "error", line }),
    },
  };
}

function step(name: string, order: string[], failure?: unknown): ShutdownStep {
  return {
    name,
    run: async () => {
      order.push(name);
      if (failure !== undefined) throw failure;
    },
  };
}

describe("runShutdownSteps", () => {
  it("runs every step in order and logs the success message once, last", async () => {
    const order: string[] = [];
    const { logger, entries } = recordingLogger();
    const clean = await runShutdownSteps([step("close worker", order), step("disconnect Prisma", order), step("close Redis connection", order)], logger);

    assert.equal(clean, true);
    assert.deepEqual(order, ["close worker", "disconnect Prisma", "close Redis connection"]);
    assert.deepEqual(entries, [{ level: "log", line: CLEAN_SHUTDOWN_MESSAGE }]);
  });

  it("does not wait for a later step before an earlier one finishes", async () => {
    const events: string[] = [];
    const slow: ShutdownStep = { name: "close worker", run: () => new Promise((resolve) => setTimeout(() => resolve(events.push("worker closed")), 20)) };
    const next: ShutdownStep = { name: "close queue", run: async () => void events.push("queue closing") };
    await runShutdownSteps([slow, next], recordingLogger().logger);
    assert.deepEqual(events, ["worker closed", "queue closing"]);
  });

  it("never logs the success message when a step fails, and names the failed step", async () => {
    const order: string[] = [];
    const { logger, entries } = recordingLogger();
    const clean = await runShutdownSteps(
      [step("close worker", order), step("disconnect Prisma", order, new Error("connection pool busy")), step("close Redis connection", order)],
      logger,
    );

    assert.equal(clean, false);
    assert.ok(!entries.some((entry) => entry.line.includes(CLEAN_SHUTDOWN_MESSAGE)));
    assert.deepEqual(entries, [
      { level: "error", line: 'Worker shutdown step "disconnect Prisma" failed: connection pool busy' },
      { level: "error", line: "Worker shutdown incomplete: 1 of 3 steps failed (disconnect Prisma)" },
    ]);
  });

  it("still runs the remaining steps after a failure so other connections are released", async () => {
    const order: string[] = [];
    await runShutdownSteps([step("close worker", order, new Error("boom")), step("close queue", order), step("close Redis connection", order)], recordingLogger().logger);
    assert.deepEqual(order, ["close worker", "close queue", "close Redis connection"]);
  });

  it("reports every failed step", async () => {
    const order: string[] = [];
    const { logger, entries } = recordingLogger();
    const clean = await runShutdownSteps([step("close worker", order, new Error("a")), step("close queue", order), step("close Redis connection", order, new Error("b"))], logger);

    assert.equal(clean, false);
    assert.equal(entries.at(-1)?.line, "Worker shutdown incomplete: 2 of 3 steps failed (close worker, close Redis connection)");
  });

  it("handles steps that throw synchronously or reject with a non-Error value", async () => {
    const { logger, entries } = recordingLogger();
    const clean = await runShutdownSteps(
      [
        {
          name: "stop reconciliation",
          run: () => {
            throw new Error("sync failure");
          },
        },
        { name: "close queue", run: () => Promise.reject("redis gone") },
      ],
      logger,
    );

    assert.equal(clean, false);
    assert.match(entries[0].line, /"stop reconciliation" failed: sync failure/);
    assert.match(entries[1].line, /"close queue" failed: redis gone/);
  });
});

describe("runShutdownSteps labels", () => {
  it("uses the label in every message", async () => {
    const { logger, entries } = recordingLogger();
    assert.equal(await runShutdownSteps([{ name: "stop HTTP server", run: async () => undefined }], logger, "API"), true);
    assert.deepEqual(entries, [{ level: "log", line: "API shut down cleanly" }]);

    const failing = recordingLogger();
    await runShutdownSteps([{ name: "stop HTTP server", run: async () => Promise.reject(new Error("timed out")) }], failing.logger, "API");
    assert.deepEqual(failing.entries.map((e) => e.line), [
      'API shutdown step "stop HTTP server" failed: timed out',
      "API shutdown incomplete: 1 of 1 steps failed (stop HTTP server)",
    ]);
  });
});

describe("shutdownSignals", () => {
  it("adds SIGBREAK only on Windows", () => {
    assert.deepEqual(shutdownSignals("win32"), ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);
    assert.deepEqual(shutdownSignals("linux"), ["SIGINT", "SIGTERM", "SIGHUP"]);
    assert.deepEqual(shutdownSignals("darwin"), ["SIGINT", "SIGTERM", "SIGHUP"]);
  });
});

describe("exitOnShutdownSignal", () => {
  function harness(shutdown: () => Promise<boolean>, timeoutMs = 1000) {
    const target = new EventEmitter();
    const exits: number[] = [];
    const lines: { level: string; line: string }[] = [];
    let calls = 0;
    exitOnShutdownSignal({
      name: "worker",
      timeoutMs,
      signals: ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"],
      target,
      exit: (code) => void exits.push(code),
      logger: {
        log: (line: string) => void lines.push({ level: "log", line }),
        warn: (line: string) => void lines.push({ level: "warn", line }),
        error: (line: string) => void lines.push({ level: "error", line }),
      },
      shutdown: () => (calls++, shutdown()),
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return { target, exits, lines, calls: () => calls, settle };
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    it(`shuts down on ${signal} and exits 0 after a clean shutdown`, async () => {
      const h = harness(async () => true);
      h.target.emit(signal);
      await h.settle();
      assert.equal(h.calls(), 1);
      assert.deepEqual(h.exits, [0]);
      assert.deepEqual(h.lines[0], { level: "log", line: `${signal} received, shutting down worker` });
    });
  }

  it("exits 1 when a shutdown step failed", async () => {
    const h = harness(async () => false);
    h.target.emit("SIGINT");
    await h.settle();
    assert.deepEqual(h.exits, [1]);
  });

  it("exits 1 if shutdown itself rejects", async () => {
    const h = harness(async () => Promise.reject(new Error("boom")));
    h.target.emit("SIGINT");
    await h.settle();
    assert.deepEqual(h.exits, [1]);
    assert.ok(h.lines.some((l) => l.line === "worker shutdown failed: boom"));
  });

  it("runs shutdown once and ignores further signals of any kind while it is in progress", async () => {
    let finish!: (clean: boolean) => void;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    h.target.emit("SIGINT");
    h.target.emit("SIGINT");
    h.target.emit("SIGTERM");
    h.target.emit("SIGBREAK");
    assert.equal(h.calls(), 1);
    assert.deepEqual(
      h.lines.filter((l) => l.level === "warn").map((l) => l.line),
      [
        "SIGINT received, worker shutdown already in progress",
        "SIGTERM received, worker shutdown already in progress",
        "SIGBREAK received, worker shutdown already in progress",
      ],
    );
    assert.deepEqual(h.exits, [], "nothing exits while shutdown is still running");

    finish(true);
    await h.settle();
    assert.deepEqual(h.exits, [0]);
  });

  it("keeps listening after the first signal, so tsx never sees a signal without a listener", () => {
    const h = harness(() => new Promise(() => undefined));
    h.target.emit("SIGINT");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) assert.equal(h.target.listenerCount(signal), 1, signal);
  });

  it("exits 1 at the deadline when shutdown hangs, and only once", async () => {
    let finish!: (clean: boolean) => void;
    const h = harness(() => new Promise((resolve) => (finish = resolve)), 30);
    h.target.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(h.exits, [1]);
    assert.ok(h.lines.some((l) => l.level === "error" && l.line === "worker shutdown did not finish within 30ms; exiting"));

    finish(true);
    await h.settle();
    assert.deepEqual(h.exits, [1], "a late finish does not exit again");
  });
});
