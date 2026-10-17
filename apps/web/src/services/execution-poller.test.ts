import { describe, expect, it } from "vitest";
import { httpError, networkError } from "../test-utils/axios-errors";
import type { Execution, ExecutionStatus } from "./execution";
import { abortableSleep, pollExecution, type PollOptions } from "./execution-poller";

function execution(status: ExecutionStatus, output: string | null = null): Execution {
  return { id: "exec-1", language: "cpp", code: "", input: null, output, status, createdAt: "", userId: "u" };
}

/** A fake clock: sleeping advances time instantly. */
function fakeTime(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => (now += ms),
  };
}

/** Scripted responses: a value resolves, an Error rejects; the last entry repeats. */
function scripted(...responses: (Execution | Error)[]) {
  const calls: { id: string; signal: AbortSignal }[] = [];
  const fetchExecution: PollOptions["fetchExecution"] = async (id, signal) => {
    calls.push({ id, signal });
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchExecution, calls };
}

describe("pollExecution", () => {
  it("returns the execution once it reaches a terminal status and stops requesting", async () => {
    const time = fakeTime();
    const { fetchExecution, calls } = scripted(execution("PENDING"), execution("RUNNING"), execution("COMPLETED", "42"));
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, ...time });

    expect(result).toEqual({ kind: "finished", execution: execution("COMPLETED", "42") });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.id === "exec-1")).toBe(true);
    expect(time.sleeps).toEqual([1000, 1000]);
  });

  it.each(["COMPLETED", "FAILED", "TIMEOUT"] as const)("treats %s as terminal", async (status) => {
    const { fetchExecution } = scripted(execution(status));
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, ...fakeTime() });
    expect(result.kind).toBe("finished");
  });

  it("never has more than one request in flight, even when responses are slower than the interval", async () => {
    let inFlight = 0;
    let peak = 0;
    let call = 0;
    const fetchExecution: PollOptions["fetchExecution"] = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15)); // slower than the 1ms interval below
      inFlight--;
      return execution(++call < 5 ? "RUNNING" : "COMPLETED");
    };
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, intervalMs: 1 });

    expect(result.kind).toBe("finished");
    expect(call).toBe(5);
    expect(peak).toBe(1);
  });

  it("gives up with a timeout after the overall limit", async () => {
    const time = fakeTime();
    const { fetchExecution, calls } = scripted(execution("PENDING"));
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, timeoutMs: 5000, ...time });

    expect(result).toEqual({ kind: "timeout" });
    expect(calls).toHaveLength(6); // at 0, 1, 2, 3, 4 and 5 seconds
    expect(time.now()).toBe(5000);
  });

  it("counts slow responses toward the timeout", async () => {
    const time = fakeTime();
    const fetchExecution: PollOptions["fetchExecution"] = async () => {
      time.advance(3000);
      return execution("RUNNING");
    };
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, timeoutMs: 5000, ...time });
    expect(result).toEqual({ kind: "timeout" });
  });

  it("retries transient failures and resets the count after a success", async () => {
    const { fetchExecution, calls } = scripted(
      networkError(),
      httpError(503),
      httpError(429),
      execution("RUNNING"),
      httpError(500),
      httpError(502),
      networkError(),
      execution("COMPLETED", "ok"),
    );
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, ...fakeTime() });

    expect(result.kind).toBe("finished");
    expect(calls).toHaveLength(8);
  });

  it("gives up after more than maxConsecutiveErrors transient failures in a row", async () => {
    const lastError = networkError();
    const { fetchExecution, calls } = scripted(httpError(503), httpError(503), httpError(503), lastError);
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, maxConsecutiveErrors: 3, ...fakeTime() });

    expect(result).toEqual({ kind: "failed", error: lastError });
    expect(calls).toHaveLength(4);
  });

  it.each([400, 401, 404])("fails immediately on a non-transient %i", async (status) => {
    const error = httpError(status);
    const { fetchExecution, calls } = scripted(error);
    const result = await pollExecution("exec-1", { fetchExecution, signal: new AbortController().signal, ...fakeTime() });

    expect(result).toEqual({ kind: "failed", error });
    expect(calls).toHaveLength(1);
  });

  it("passes the abort signal to every request", async () => {
    const controller = new AbortController();
    const { fetchExecution, calls } = scripted(execution("RUNNING"), execution("COMPLETED"));
    await pollExecution("exec-1", { fetchExecution, signal: controller.signal, ...fakeTime() });
    expect(calls.map((call) => call.signal)).toEqual([controller.signal, controller.signal]);
  });

  it("stops without another request when cancelled while waiting", async () => {
    const controller = new AbortController();
    const { fetchExecution, calls } = scripted(execution("RUNNING"));
    const result = await pollExecution("exec-1", {
      fetchExecution,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });

    expect(result).toEqual({ kind: "cancelled" });
    expect(calls).toHaveLength(1);
  });

  it("reports cancellation, not the result, when cancelled during a request", async () => {
    const controller = new AbortController();
    const fetchExecution: PollOptions["fetchExecution"] = async () => {
      controller.abort();
      return execution("COMPLETED", "too late");
    };
    expect(await pollExecution("exec-1", { fetchExecution, signal: controller.signal, ...fakeTime() })).toEqual({ kind: "cancelled" });
  });

  it("reports cancellation, not a failure, when the cancelled request rejects", async () => {
    const controller = new AbortController();
    const fetchExecution: PollOptions["fetchExecution"] = async () => {
      controller.abort();
      throw new Error("canceled");
    };
    expect(await pollExecution("exec-1", { fetchExecution, signal: controller.signal, ...fakeTime() })).toEqual({ kind: "cancelled" });
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchExecution, calls } = scripted(execution("RUNNING"));
    expect(await pollExecution("exec-1", { fetchExecution, signal: controller.signal })).toEqual({ kind: "cancelled" });
    expect(calls).toHaveLength(0);
  });
});

describe("abortableSleep", () => {
  it("resolves early when aborted and immediately when already aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
    await abortableSleep(10_000, controller.signal);
  });
});
