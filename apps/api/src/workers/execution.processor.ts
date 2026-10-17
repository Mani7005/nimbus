import type { Job } from "bullmq";
import type { ExecutionJobData } from "../queues/execution.job.js";
import {
  INFRASTRUCTURE_ERROR_OUTPUT,
  formatExecutionOutput,
  toExecutionStatus,
  type ExecutionResult,
} from "../runtime/execution-result.js";
import { getErrorMessage } from "../utils/errors.js";

// Only executions in these states may be (re)started or marked failed, so a retry never overwrites a finished result.
const ACTIVE_STATUSES = ["PENDING", "RUNNING"];

export const UNSUPPORTED_LANGUAGE_OUTPUT = "Language not supported";

export interface ExecutionStore {
  findUnique(args: { where: { id: string } }): Promise<{ language: string; code: string; input: string | null } | null>;
  updateMany(args: {
    where: { id: string; status: { in: string[] } };
    data: { status: string; output: string | null };
  }): Promise<{ count: number }>;
}

export interface ExecutionJobDeps {
  executions: ExecutionStore;
  executeCpp: (code: string, input: string) => Promise<ExecutionResult>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

type ProcessableJob = Pick<Job<ExecutionJobData>, "id" | "data" | "attemptsMade">;
type FailedJob = Pick<Job<ExecutionJobData>, "id" | "data" | "attemptsMade" | "opts">;

/**
 * Runs one execution. User-code outcomes (compilation/runtime errors, timeouts) are persisted and complete the
 * job; infrastructure and persistence errors are thrown so BullMQ retries them.
 */
export async function processExecutionJob(job: ProcessableJob, deps: ExecutionJobDeps): Promise<void> {
  const { executions, logger = console } = deps;
  const { executionId } = job.data;
  logger.log(`Processing execution ${executionId} (attempt ${job.attemptsMade + 1})`);

  // Clears any output left by an earlier attempt.
  const started = await executions.updateMany({
    where: { id: executionId, status: { in: ACTIVE_STATUSES } },
    data: { status: "RUNNING", output: null },
  });
  const execution = started.count > 0 ? await executions.findUnique({ where: { id: executionId } }) : null;
  if (!execution) {
    logger.warn(`Skipping execution ${executionId}: missing or already finished`);
    return;
  }

  let status: string;
  let output: string;

  if (execution.language === "cpp") {
    const result = await deps.executeCpp(execution.code, execution.input || "");
    if (result.outcome === "INFRASTRUCTURE_ERROR") throw new Error(`Infrastructure error: ${result.message}`);
    status = toExecutionStatus(result.outcome);
    output = formatExecutionOutput(result);
  } else {
    status = "FAILED";
    output = UNSUPPORTED_LANGUAGE_OUTPUT;
  }

  const saved = await executions.updateMany({
    where: { id: executionId, status: { in: ACTIVE_STATUSES } },
    data: { status, output },
  });
  if (saved.count === 0) logger.warn(`Execution ${executionId} was removed before its result could be saved`);
  else logger.log(`${status}: ${executionId}`);
}

/** Mirrors BullMQ's retry decision; the `failed` event fires after every failed attempt, not only the last. */
export function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">, error: Error): boolean {
  if (error.name === "UnrecoverableError") return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/** Handles BullMQ's `failed` event. Never rejects; persistence errors are logged. */
export async function handleFailedExecutionJob(job: FailedJob | undefined, error: Error, deps: ExecutionJobDeps): Promise<void> {
  const { executions, logger = console } = deps;
  const executionId = job?.data?.executionId;

  try {
    if (!job || !executionId) {
      logger.error(`Execution job ${job?.id ?? "unknown"} failed without an execution id: ${getErrorMessage(error)}`);
      return;
    }

    const attempts = `${job.attemptsMade}/${job.opts.attempts ?? 1}`;
    const where = { id: executionId, status: { in: ACTIVE_STATUSES } };

    if (!isFinalAttempt(job, error)) {
      logger.warn(`Execution ${executionId} attempt ${attempts} failed, will retry: ${getErrorMessage(error)}`);
      await executions.updateMany({ where, data: { status: "PENDING", output: null } });
      return;
    }

    logger.error(`Execution ${executionId} failed after attempt ${attempts}: ${getErrorMessage(error)}`);
    const { count } = await executions.updateMany({ where, data: { status: "FAILED", output: INFRASTRUCTURE_ERROR_OUTPUT } });
    if (count === 0) logger.warn(`Execution ${executionId} not marked FAILED: missing or already finished`);
  } catch (persistError) {
    logger.error(`Could not record failure of execution ${executionId ?? "unknown"}: ${getErrorMessage(persistError)}`);
  }
}
