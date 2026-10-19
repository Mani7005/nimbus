import { isTransientError } from "./api-errors";
import type { Execution } from "./execution";

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "FAILED", "TIMEOUT"]);

export type PollResult =
  | { kind: "finished"; execution: Execution }
  | { kind: "timeout" }
  | { kind: "failed"; error: unknown }
  | { kind: "cancelled" };

export interface PollOptions {
  fetchExecution: (id: string, signal: AbortSignal) => Promise<Execution>;
  signal: AbortSignal;
  intervalMs?: number;
  /** Overall limit measured from the start of polling. */
  timeoutMs?: number;
  /** Transient failures in a row tolerated before giving up; a success resets the count. */
  maxConsecutiveErrors?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Resolves after ms, or immediately once the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Polls one execution until it reaches a terminal status. Requests are sequential: the next is scheduled only after
 * the previous one settles, so responses can never overlap or arrive out of order. Never rejects.
 */
export async function pollExecution(id: string, options: PollOptions): Promise<PollResult> {
  const {
    fetchExecution,
    signal,
    intervalMs = 1000,
    timeoutMs = 120_000,
    maxConsecutiveErrors = 3,
    now = Date.now,
    sleep = abortableSleep,
  } = options;
  const deadline = now() + timeoutMs;
  let consecutiveErrors = 0;

  while (!signal.aborted) {
    try {
      const execution = await fetchExecution(id, signal);
      if (signal.aborted) break;
      consecutiveErrors = 0;
      if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) return { kind: "finished", execution };
    } catch (error) {
      if (signal.aborted) break;
      if (!isTransientError(error) || ++consecutiveErrors > maxConsecutiveErrors) return { kind: "failed", error };
    }

    if (now() + intervalMs > deadline) return { kind: "timeout" };
    await sleep(intervalMs, signal);
  }
  return { kind: "cancelled" };
}
