/** Execution statuses that are final. Only these are ever deleted: PENDING and RUNNING rows belong to queued jobs. */
export const FINISHED_EXECUTION_STATUSES = ["COMPLETED", "FAILED", "TIMEOUT"] as const;

/** Rows deleted per statement, so no single statement holds many row locks for long. */
export const RETENTION_BATCH_SIZE = 1000;

/**
 * Statements per limit in one sweep. A sweep repeats full batches until one comes back short, so a backlog is cleared
 * in a single sweep (up to 50,000 rows per limit) instead of falling behind a busy worker; the cap keeps a sweep
 * bounded, and the next sweep continues where it stopped.
 */
export const RETENTION_MAX_BATCHES_PER_SWEEP = 50;

export interface RetentionBatching {
  batchSize?: number;
  maxBatches?: number;
}

export interface RetentionLimits {
  /** Finished executions kept per user (newest first); 0 keeps all. */
  maxPerUser: number;
  /** Finished executions kept across all users (newest first); 0 keeps all. */
  maxTotal: number;
}

export interface RetentionSummary {
  deletedPerUser: number;
  deletedTotal: number;
}

export interface RetentionStore {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export function isRetentionEnabled(limits: RetentionLimits): boolean {
  return limits.maxPerUser > 0 || limits.maxTotal > 0;
}

export function describeRetention(limits: RetentionLimits): string {
  if (!isRetentionEnabled(limits)) return "Execution history retention: disabled (all finished executions are kept)";
  const describe = (limit: number) => (limit > 0 ? `${limit}` : "unlimited");
  return `Execution history retention: keeping the newest ${describe(limits.maxPerUser)} finished executions per user, ${describe(limits.maxTotal)} in total`;
}

async function deleteInBatches(deleteBatch: () => Promise<number>, batchSize: number, maxBatches: number): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const count = await deleteBatch();
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

/**
 * Deletes the oldest finished executions beyond the per-user and total limits. Ties on createdAt are broken by id, so
 * the kept set is deterministic. Unfinished executions are never selected, and the status is checked again by the
 * DELETE itself. Every status update elsewhere is conditioned on PENDING/RUNNING, so a finished execution never
 * becomes active again, and deleting one cannot affect its BullMQ job, which is already complete.
 */
export async function pruneExecutionHistory(
  db: RetentionStore,
  limits: RetentionLimits,
  { batchSize = RETENTION_BATCH_SIZE, maxBatches = RETENTION_MAX_BATCHES_PER_SWEEP }: RetentionBatching = {},
): Promise<RetentionSummary> {
  let deletedPerUser = 0;
  let deletedTotal = 0;

  if (limits.maxPerUser > 0) {
    deletedPerUser = await deleteInBatches(() => db.$executeRaw`
      DELETE FROM "Execution"
      WHERE status IN ('COMPLETED', 'FAILED', 'TIMEOUT')
        AND id IN (
          SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY "userId" ORDER BY "createdAt" DESC, id DESC) AS position
            FROM "Execution"
            WHERE status IN ('COMPLETED', 'FAILED', 'TIMEOUT')
          ) ranked
          WHERE position > ${limits.maxPerUser}
          LIMIT ${batchSize}
        )`, batchSize, maxBatches);
  }

  if (limits.maxTotal > 0) {
    deletedTotal = await deleteInBatches(() => db.$executeRaw`
      DELETE FROM "Execution"
      WHERE status IN ('COMPLETED', 'FAILED', 'TIMEOUT')
        AND id IN (
          SELECT id FROM "Execution"
          WHERE status IN ('COMPLETED', 'FAILED', 'TIMEOUT')
          ORDER BY "createdAt" DESC, id DESC
          OFFSET ${limits.maxTotal}
          LIMIT ${batchSize}
        )`, batchSize, maxBatches);
  }

  return { deletedPerUser, deletedTotal };
}
