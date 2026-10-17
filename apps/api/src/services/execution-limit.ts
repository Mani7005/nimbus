import type { PrismaClient } from "@prisma/client";

export const UNFINISHED_EXECUTION_STATUSES = ["PENDING", "RUNNING"];

// Advisory-lock namespace ("NIMB"), so these per-user locks cannot collide with other advisory locks.
const LOCK_NAMESPACE = 0x4e494d42;

/** The user already has the maximum number of PENDING/RUNNING executions. */
export class ActiveExecutionLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Active execution limit of ${limit} reached`);
    this.name = "ActiveExecutionLimitError";
  }
}

export interface NewExecution {
  language: string;
  code: string;
  input: string;
}

/**
 * Inserts a PENDING execution unless the user already has maxActive unfinished ones. The count and the insert run
 * in one transaction holding a per-user advisory lock, so concurrent submissions from the same user (on any API
 * instance sharing the database) are serialized and cannot both take the last slot. Other users are not blocked.
 * The lock is released when the transaction commits or rolls back. Nothing is written when the limit is reached.
 */
export function createExecutionWithinLimit(db: PrismaClient, userId: string, execution: NewExecution, maxActive: number) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::integer, hashtext(${userId}::text))`;
    const active = await tx.execution.count({ where: { userId, status: { in: UNFINISHED_EXECUTION_STATUSES } } });
    if (active >= maxActive) throw new ActiveExecutionLimitError(maxActive);
    return tx.execution.create({ data: { ...execution, userId, status: "PENDING" } });
  });
}
