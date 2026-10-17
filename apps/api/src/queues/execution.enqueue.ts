import type { ExecutionJobData } from "./execution.job.js";

export interface ExecutionJobQueue {
  add(name: string, data: ExecutionJobData, opts: { jobId: string }): Promise<unknown>;
}

export class EnqueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Enqueue timed out after ${timeoutMs}ms`);
    this.name = "EnqueueTimeoutError";
  }
}

/**
 * Adds the job under the execution's id, failing after timeoutMs. BullMQ waits for Redis indefinitely, so the
 * abandoned add may still complete later; its outcome is ignored and a late rejection cannot go unhandled.
 */
export function enqueueExecution(queue: ExecutionJobQueue, executionId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EnqueueTimeoutError(timeoutMs)), timeoutMs);

    Promise.resolve()
      .then(() => queue.add("execute-code", { executionId }, { jobId: executionId }))
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
