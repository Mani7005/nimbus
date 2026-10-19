import type { PrismaClient } from "@prisma/client";

export const UNFINISHED_EXECUTION_STATUSES = ["PENDING", "RUNNING"];

// Advisory-lock namespace ("NIMB"), so these per-user locks cannot collide with other advisory locks.
const LOCK_NAMESPACE = 0x4e494d42;
// A separate namespace ("NIMG") for the single global lock, so no user's hashed key can ever equal it.
const GLOBAL_LOCK_NAMESPACE = 0x4e494d47;
const GLOBAL_LOCK_KEY = 0;

/** The user already has the maximum number of PENDING/RUNNING executions. */
export class ActiveExecutionLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Active execution limit of ${limit} reached`);
    this.name = "ActiveExecutionLimitError";
  }
}

/** All users together already have the maximum number of PENDING/RUNNING executions. */
export class GlobalActiveExecutionLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Global active execution limit of ${limit} reached`);
    this.name = "GlobalActiveExecutionLimitError";
  }
}

export interface NewExecution {
  language: string;
  code: string;
  input: string;
}

/**
 * Inserts a PENDING execution unless the user already has maxActive unfinished ones, or (when maxActiveTotal > 0)
 * all users together already have maxActiveTotal. The counts and the insert run in one transaction holding advisory
 * locks, so concurrent submissions (on any API instance sharing the database) are serialized and cannot both take
 * the last slot:
 * - a per-user lock, so other users are not blocked by the per-user check;
 * - when the global cap is enabled, one global lock taken first. Every submitter takes the locks in the same order
 *   (global, then user), so they cannot deadlock. Rows only become unfinished through this insert, so while the
 *   global lock is held the global count can only fall (executions finishing), never rise.
 * The per-user cap is checked first, so a user at their own limit is told so rather than that the service is busy.
 * The locks are released when the transaction commits or rolls back. Nothing is written when a limit is reached.
 */
export function createExecutionWithinLimit(db: PrismaClient, userId: string, execution: NewExecution, maxActive: number, maxActiveTotal = 0) {
  return db.$transaction(async (tx) => {
    if (maxActiveTotal > 0) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${GLOBAL_LOCK_NAMESPACE}::integer, ${GLOBAL_LOCK_KEY}::integer)`;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::integer, hashtext(${userId}::text))`;
    const active = await tx.execution.count({ where: { userId, status: { in: UNFINISHED_EXECUTION_STATUSES } } });
    if (active >= maxActive) throw new ActiveExecutionLimitError(maxActive);
    if (maxActiveTotal > 0) {
      const activeTotal = await tx.execution.count({ where: { status: { in: UNFINISHED_EXECUTION_STATUSES } } });
      if (activeTotal >= maxActiveTotal) throw new GlobalActiveExecutionLimitError(maxActiveTotal);
    }
    return tx.execution.create({ data: { ...execution, userId, status: "PENDING" } });
  });
}
