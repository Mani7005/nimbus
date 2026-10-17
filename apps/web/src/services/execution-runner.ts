import { getApiErrorMessage } from "./api-errors";
import type { Execution } from "./execution";
import { pollExecution, type PollOptions } from "./execution-poller";

export const RUNNING_MESSAGE = "Running...";
export const SUBMIT_FAILED_MESSAGE = "Execution failed. Please try again.";
export const POLL_FAILED_MESSAGE = "Could not fetch the execution result. Check your history shortly.";
export const POLL_TIMEOUT_MESSAGE = "Still waiting for the result. Check your history again shortly.";

export interface ExecutionRunnerDeps {
  submit: (language: string, code: string, input: string) => Promise<Execution>;
  fetchExecution: PollOptions["fetchExecution"];
  /** Overrides for the polling loop, e.g. timing in tests. */
  poll?: Omit<PollOptions, "fetchExecution" | "signal">;
}

/** Callbacks for one run. */
export interface RunCallbacks {
  onOutput: (output: string) => void;
  /** Called exactly once per run, when the execution reaches a terminal status. */
  onComplete: (output: string) => Promise<void> | void;
}

/** Submits one execution at a time and polls it to completion. Framework-free, so it can be tested directly. */
export class ExecutionRunner {
  private current: AbortController | undefined;
  private readonly deps: ExecutionRunnerDeps;
  private readonly onBusyChange: (busy: boolean) => void;

  constructor(deps: ExecutionRunnerDeps, onBusyChange: (busy: boolean) => void) {
    this.deps = deps;
    this.onBusyChange = onBusyChange;
  }

  get busy(): boolean {
    return this.current !== undefined;
  }

  /** Ignored while a run is in progress. Never rejects. */
  async run(language: string, code: string, input: string, callbacks: RunCallbacks): Promise<void> {
    if (this.current) return;
    const controller = new AbortController();
    this.current = controller;
    const { signal } = controller;
    this.onBusyChange(true);
    callbacks.onOutput(RUNNING_MESSAGE);

    try {
      let execution: Execution;
      try {
        execution = await this.deps.submit(language, code, input);
      } catch (error) {
        if (!signal.aborted) callbacks.onOutput(getApiErrorMessage(error, SUBMIT_FAILED_MESSAGE));
        return;
      }
      if (signal.aborted) return;

      const result = await pollExecution(execution.id, { ...this.deps.poll, fetchExecution: this.deps.fetchExecution, signal });
      if (signal.aborted) return;
      switch (result.kind) {
        case "finished": {
          const output = result.execution.output || "No Output";
          callbacks.onOutput(output);
          await callbacks.onComplete(output);
          break;
        }
        case "timeout":
          callbacks.onOutput(POLL_TIMEOUT_MESSAGE);
          break;
        case "failed":
          callbacks.onOutput(getApiErrorMessage(result.error, POLL_FAILED_MESSAGE));
          break;
      }
    } finally {
      this.finish(controller);
    }
  }

  /** Stops the current run, if any: no further requests, output or completion callbacks. */
  cancel(): void {
    const controller = this.current;
    if (!controller) return;
    controller.abort();
    this.finish(controller);
  }

  private finish(controller: AbortController): void {
    if (this.current !== controller) return;
    this.current = undefined;
    this.onBusyChange(false);
  }
}
