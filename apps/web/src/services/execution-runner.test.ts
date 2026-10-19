import { describe, expect, it } from "vitest";
import { httpError, networkError } from "../test-utils/axios-errors";
import { NETWORK_ERROR_MESSAGE } from "./api-errors";
import type { Execution, ExecutionStatus } from "./execution";
import {
  ExecutionRunner,
  POLL_FAILED_MESSAGE,
  POLL_TIMEOUT_MESSAGE,
  RUNNING_MESSAGE,
  SUBMIT_FAILED_MESSAGE,
  type ExecutionRunnerDeps,
} from "./execution-runner";

function execution(status: ExecutionStatus, output: string | null = null): Execution {
  return { id: "exec-1", language: "cpp", code: "", input: null, output, status, createdAt: "", userId: "u" };
}

const instantPolling = { intervalMs: 1, sleep: async () => undefined };

/** A runner whose `run` records output and completions; submit and fetch calls are counted, even when overridden. */
function setup({ submit, fetchExecution, poll = instantPolling }: Partial<ExecutionRunnerDeps> = {}) {
  const outputs: string[] = [];
  const busy: boolean[] = [];
  const completed: string[] = [];
  const submits: unknown[][] = [];
  let fetches = 0;
  const runner = new ExecutionRunner(
    {
      submit: async (...args) => {
        submits.push(args);
        return submit ? submit(...args) : execution("PENDING");
      },
      fetchExecution: async (id, signal) => {
        fetches++;
        return fetchExecution ? fetchExecution(id, signal) : execution("COMPLETED", "42");
      },
      poll,
    },
    (value) => void busy.push(value),
  );
  const callbacks = { onOutput: (output: string) => void outputs.push(output), onComplete: (output: string) => void completed.push(output) };
  const run = (language: string, code: string, input: string) => runner.run(language, code, input, callbacks);
  return { runner, run, outputs, busy, completed, submits, fetches: () => fetches };
}

describe("ExecutionRunner", () => {
  it("submits, polls to completion, shows the output and calls onComplete exactly once", async () => {
    const statuses: ExecutionStatus[] = ["PENDING", "RUNNING", "COMPLETED"];
    const t = setup({ fetchExecution: async () => execution(statuses.shift() ?? "COMPLETED", "42") });
    await t.run("cpp", "int main() {}", "1 2");

    expect(t.submits).toEqual([["cpp", "int main() {}", "1 2"]]);
    expect(t.outputs).toEqual([RUNNING_MESSAGE, "42"]);
    expect(t.completed).toEqual(["42"]);
    expect(t.busy).toEqual([true, false]);
    expect(t.runner.busy).toBe(false);
  });

  it("shows 'No Output' for an empty result", async () => {
    const t = setup({ fetchExecution: async () => execution("COMPLETED", "") });
    await t.run("cpp", "", "");
    expect(t.completed).toEqual(["No Output"]);
  });

  it("is busy for the whole submit-and-poll cycle and ignores Run while busy", async () => {
    let finish!: () => void;
    const t = setup({ fetchExecution: () => new Promise((resolve) => (finish = () => resolve(execution("COMPLETED", "done")))) });
    const first = t.run("cpp", "a", "");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(t.runner.busy).toBe(true);
    await t.run("cpp", "b", "");
    expect(t.submits).toHaveLength(1);

    finish();
    await first;
    expect(t.runner.busy).toBe(false);
    expect(t.completed).toEqual(["done"]);
  });

  it.each([
    [400, "code: Too big: expected string to have <=50000 characters"],
    [429, "You already have 3 unfinished executions. Wait for one to finish before submitting another."],
    [429, "Too many execution requests. Please wait before submitting again."],
    [503, "Execution service unavailable. Please try again."],
  ])("shows the API message when submitting fails with %i", async (status, message) => {
    const t = setup({
      submit: async () => {
        throw httpError(status, { success: false, message });
      },
    });
    await t.run("cpp", "", "");

    expect(t.outputs).toEqual([RUNNING_MESSAGE, message]);
    expect(t.completed).toEqual([]);
    expect(t.fetches()).toBe(0);
    expect(t.busy).toEqual([true, false]);
  });

  it("shows a generic message for a 500 and a connection message for a network failure", async () => {
    const t500 = setup({ submit: async () => Promise.reject(httpError(500, { success: false, message: "Internal server error" })) });
    await t500.run("cpp", "", "");
    expect(t500.outputs.at(-1)).toBe(SUBMIT_FAILED_MESSAGE);

    const offline = setup({ submit: async () => Promise.reject(networkError()) });
    await offline.run("cpp", "", "");
    expect(offline.outputs.at(-1)).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("reports a polling failure without calling onComplete", async () => {
    const t = setup({ fetchExecution: async () => Promise.reject(httpError(404, { success: false, message: "Execution not found" })) });
    await t.run("cpp", "", "");
    expect(t.outputs.at(-1)).toBe("Execution not found");
    expect(t.completed).toEqual([]);

    const generic = setup({ fetchExecution: async () => Promise.reject(httpError(500)), poll: { ...instantPolling, maxConsecutiveErrors: 0 } });
    await generic.run("cpp", "", "");
    expect(generic.outputs.at(-1)).toBe(POLL_FAILED_MESSAGE);
  });

  it("reports a timeout without calling onComplete", async () => {
    let now = 0;
    const t = setup({
      fetchExecution: async () => execution("RUNNING"),
      poll: { intervalMs: 1000, timeoutMs: 3000, now: () => now, sleep: async (ms) => void (now += ms) },
    });
    await t.run("cpp", "", "");
    expect(t.outputs.at(-1)).toBe(POLL_TIMEOUT_MESSAGE);
    expect(t.completed).toEqual([]);
    expect(t.busy).toEqual([true, false]);
  });

  it("cancel stops polling at once: no more requests, output or completion, and Run is available again", async () => {
    let releaseSleep!: () => void;
    const t = setup({
      fetchExecution: async () => execution("RUNNING"),
      poll: { intervalMs: 1000, sleep: (_ms, signal) => new Promise<void>((resolve) => ((releaseSleep = resolve), signal.addEventListener("abort", () => resolve()))) },
    });
    const running = t.run("cpp", "", "");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.fetches()).toBe(1);

    t.runner.cancel();
    expect(t.runner.busy).toBe(false);
    expect(t.busy).toEqual([true, false]);
    releaseSleep();
    await running;

    expect(t.fetches()).toBe(1);
    expect(t.outputs).toEqual([RUNNING_MESSAGE]);
    expect(t.completed).toEqual([]);
    expect(t.busy, "busy is not reported false twice").toEqual([true, false]);
  });

  it("cancel during submission prevents polling once the submission returns", async () => {
    let resolveSubmit!: (execution: Execution) => void;
    const t = setup({ submit: () => new Promise((resolve) => (resolveSubmit = resolve)) });
    const running = t.run("cpp", "", "");

    t.runner.cancel();
    resolveSubmit(execution("PENDING"));
    await running;

    expect(t.fetches()).toBe(0);
    expect(t.outputs).toEqual([RUNNING_MESSAGE]);
    expect(t.completed).toEqual([]);
  });

  it("accepts a new run right after cancelling, without waiting for the cancelled one to settle", async () => {
    let submits = 0;
    const t = setup({
      submit: async () => {
        // The first submission never returns; the second succeeds.
        if (++submits === 1) return new Promise<Execution>(() => undefined);
        return execution("PENDING");
      },
    });
    void t.run("cpp", "a", "");
    t.runner.cancel();

    await t.run("cpp", "b", "");
    expect(submits).toBe(2);
    expect(t.completed).toEqual(["42"]);
    expect(t.busy).toEqual([true, false, true, false]);
  });

  it("cancel without a run in progress does nothing", () => {
    const t = setup();
    t.runner.cancel();
    expect(t.busy).toEqual([]);
  });
});
