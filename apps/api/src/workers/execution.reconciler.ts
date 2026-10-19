import type { JobType } from "bullmq";
import { INFRASTRUCTURE_ERROR_OUTPUT } from "../runtime/execution-result.js";
import { getErrorMessage } from "../utils/errors.js";

export const RECONCILED_OUTPUT = INFRASTRUCTURE_ERROR_OUTPUT;

const ACTIVE_STATUSES = ["PENDING", "RUNNING"];

/** Job states after which BullMQ will never process the job again. */
const FINISHED_JOB_STATES = new Set(["completed", "failed"]);

/** States in which a job may still run; used to find jobs enqueued before jobId = execution.id. */
export const LIVE_JOB_STATES: JobType[] = ["waiting", "active", "delayed", "prioritized", "paused", "waiting-children"];

export interface StaleExecution {
  id: string;
  status: string;
  createdAt: Date;
}

export interface ReconcileStore {
  findMany(args: {
    where: {
      status: { in: string[] };
      createdAt: { lt: Date };
      OR?: [{ createdAt: { gt: Date } }, { createdAt: Date; id: { gt: string } }];
    };
    orderBy: [{ createdAt: "asc" }, { id: "asc" }];
    take: number;
    select: { id: true; status: true; createdAt: true };
  }): Promise<StaleExecution[]>;
  updateMany(args: {
    where: { id: string; status: string };
    data: { status: string; output: string };
  }): Promise<{ count: number }>;
}

export interface JobStateLookup {
  getJobState(jobId: string): Promise<string>;
  getJobCounts(...types: JobType[]): Promise<Record<string, number>>;
  getJobs(types: JobType[], start?: number, end?: number): Promise<({ data?: { executionId?: unknown } } | undefined)[]>;
}

export interface ReconcileOptions {
  store: ReconcileStore;
  queue: JobStateLookup;
  graceMs: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  now?: () => Date;
  batchSize?: number;
  maxBatches?: number;
  lookupTimeoutMs?: number;
  /** Stops the sweep after this many lookup failures in a row, treating Redis as unavailable. */
  maxConsecutiveLookupFailures?: number;
  /** Above this many live jobs the legacy-job scan is incomplete, so unknown jobs are left untouched. */
  legacyScanLimit?: number;
}

export interface ReconcileSummary {
  scanned: number;
  markedFailed: number;
  inProgress: number;
  skipped: number;
  errors: number;
  aborted: boolean;
}

class LookupTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Redis lookup timed out after ${timeoutMs}ms`);
    this.name = "LookupTimeoutError";
  }
}

// BullMQ waits indefinitely for Redis; a late rejection of an abandoned lookup is ignored.
function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LookupTimeoutError(timeoutMs)), timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Execution ids referenced by live jobs, including jobs enqueued before jobId = execution.id whose state cannot be
 * looked up by execution id. Returns null when the scan cannot be trusted to be complete.
 */
async function findLiveJobExecutionIds(queue: JobStateLookup, limit: number, timeoutMs: number): Promise<Set<string> | null> {
  const counts = await withTimeout(() => queue.getJobCounts(...LIVE_JOB_STATES), timeoutMs);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total > limit) return null;

  const jobs = await withTimeout(() => queue.getJobs(LIVE_JOB_STATES, 0, -1), timeoutMs);
  const ids = new Set<string>();
  for (const job of jobs) {
    if (typeof job?.data?.executionId === "string") ids.add(job.data.executionId);
  }
  return ids;
}

/**
 * Marks PENDING/RUNNING executions FAILED when no BullMQ job can still finish them: the job completed or failed
 * without the result being saved, or it no longer exists. Every lookup failure leaves the execution untouched.
 * Never rejects.
 */
export async function reconcileOrphanedExecutions(options: ReconcileOptions): Promise<ReconcileSummary> {
  const {
    store,
    queue,
    graceMs,
    logger = console,
    now = () => new Date(),
    batchSize = 100,
    maxBatches = 10,
    lookupTimeoutMs = 5000,
    maxConsecutiveLookupFailures = 3,
    legacyScanLimit = 1000,
  } = options;

  const summary: ReconcileSummary = { scanned: 0, markedFailed: 0, inProgress: 0, skipped: 0, errors: 0, aborted: false };
  const cutoff = new Date(now().getTime() - graceMs);
  let liveJobExecutionIds: Promise<Set<string> | null> | undefined;
  let consecutiveLookupFailures = 0;
  let last: StaleExecution | undefined;

  const getLiveJobExecutionIds = () =>
    (liveJobExecutionIds ??= findLiveJobExecutionIds(queue, legacyScanLimit, lookupTimeoutMs).catch((error: unknown) => {
      logger.warn(`Reconciliation could not scan live jobs: ${getErrorMessage(error)}`);
      return null;
    }));

  for (let batch = 0; batch < maxBatches; batch++) {
    let rows: StaleExecution[];
    try {
      rows = await store.findMany({
        where: {
          status: { in: ACTIVE_STATUSES },
          createdAt: { lt: cutoff },
          ...(last && { OR: [{ createdAt: { gt: last.createdAt } }, { createdAt: last.createdAt, id: { gt: last.id } }] }),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: batchSize,
        select: { id: true, status: true, createdAt: true },
      });
    } catch (error) {
      logger.error(`Reconciliation could not load executions: ${getErrorMessage(error)}`);
      summary.errors++;
      summary.aborted = true;
      return summary;
    }

    for (const execution of rows) {
      summary.scanned++;

      let state: string;
      try {
        state = await withTimeout(() => queue.getJobState(execution.id), lookupTimeoutMs);
        consecutiveLookupFailures = 0;
      } catch (error) {
        logger.warn(`Reconciliation left execution ${execution.id} untouched, job lookup failed: ${getErrorMessage(error)}`);
        summary.skipped++;
        if (++consecutiveLookupFailures >= maxConsecutiveLookupFailures) {
          logger.error(`Reconciliation stopped after ${consecutiveLookupFailures} consecutive job lookup failures`);
          summary.aborted = true;
          return summary;
        }
        continue;
      }

      if (state === "unknown") {
        const liveIds = await getLiveJobExecutionIds();
        if (!liveIds) {
          summary.skipped++;
          continue;
        }
        if (liveIds.has(execution.id)) {
          summary.inProgress++;
          continue;
        }
      } else if (!FINISHED_JOB_STATES.has(state)) {
        summary.inProgress++;
        continue;
      }

      try {
        const { count } = await store.updateMany({
          where: { id: execution.id, status: execution.status },
          data: { status: "FAILED", output: RECONCILED_OUTPUT },
        });
        if (count > 0) {
          summary.markedFailed++;
          logger.warn(`Reconciled execution ${execution.id} from ${execution.status} to FAILED (job state: ${state})`);
        }
      } catch (error) {
        logger.error(`Reconciliation could not update execution ${execution.id}: ${getErrorMessage(error)}`);
        summary.errors++;
      }
    }

    if (rows.length < batchSize) break;
    last = rows[rows.length - 1];
  }

  return summary;
}
