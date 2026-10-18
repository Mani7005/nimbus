import { env } from "../config/env.js";
import prisma from "../lib/prisma.js";
import { enqueueExecution } from "../queues/execution.enqueue.js";
import { executionQueue } from "../queues/execution.queue.js";
import { getErrorMessage } from "../utils/errors.js";
import { listExecutionsPage } from "./execution-history.js";
import { createExecutionWithinLimit } from "./execution-limit.js";

export const ENQUEUE_FAILED_OUTPUT = "Execution could not be queued. Please try again.";

/** The execution was saved but could not be handed to the queue. */
export class ExecutionUnavailableError extends Error {
  constructor() {
    super("Execution service unavailable");
    this.name = "ExecutionUnavailableError";
  }
}

/**
 * Marks a PENDING execution FAILED after its enqueue failed. Returns false when the execution already left
 * PENDING, which means a worker picked up a job whose enqueue was confirmed too late.
 */
async function markEnqueueFailed(id: string): Promise<boolean> {
  try {
    const { count } = await prisma.execution.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "FAILED", output: ENQUEUE_FAILED_OUTPUT },
    });
    return count > 0;
  } catch (error) {
    console.error(`Could not mark execution ${id} FAILED after enqueue failure: ${getErrorMessage(error)}`);
    return true;
  }
}

/**
 * Throws ActiveExecutionLimitError (the user's cap) or GlobalActiveExecutionLimitError (the service-wide cap) before
 * writing anything or queueing a job.
 */
export async function createExecution(userId: string, language: string, code: string, input: string) {
  const execution = await createExecutionWithinLimit(
    prisma,
    userId,
    { language, code, input },
    env.EXECUTION_MAX_ACTIVE_PER_USER,
    env.EXECUTION_MAX_ACTIVE_TOTAL,
  );

  try {
    await enqueueExecution(executionQueue, execution.id, env.EXECUTION_ENQUEUE_TIMEOUT_MS);
  } catch (error) {
    console.error(`Could not enqueue execution ${execution.id}: ${getErrorMessage(error)}`);
    if (await markEnqueueFailed(execution.id)) throw new ExecutionUnavailableError();
  }

  return execution;
}

export function getExecution(id: string, userId: string) {
  return prisma.execution.findFirst({ where: { id, userId } });
}

/** Returns null when the cursor is not one of the user's executions. */
export function getUserExecutions(userId: string, page: { limit: number; cursor?: string }) {
  return listExecutionsPage(prisma, userId, page);
}

/** Returns false when no execution with this id belongs to the user. */
export async function deleteExecution(id: string, userId: string): Promise<boolean> {
  const { count } = await prisma.execution.deleteMany({ where: { id, userId } });
  return count > 0;
}
