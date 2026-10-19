import type { JobsOptions } from "bullmq";

export interface ExecutionJobData {
  executionId: string;
}

// BullMQ trims finished jobs whenever another job finishes; a job is removed once it exceeds either bound. Results
// live in Postgres, so completed jobs are only kept briefly; failures are kept longer for debugging.
export const COMPLETED_JOB_RETENTION = { age: 24 * 60 * 60, count: 1000 }; // seconds, jobs
export const FAILED_JOB_RETENTION = { age: 7 * 24 * 60 * 60, count: 5000 }; // seconds, jobs

// Retries cover thrown processing errors (database, Redis or Docker infrastructure failures), not user-code
// results such as compilation or runtime errors, which complete the job normally. Delays: 2s, then 4s.
export const EXECUTION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: COMPLETED_JOB_RETENTION,
  removeOnFail: FAILED_JOB_RETENTION,
} satisfies JobsOptions;
