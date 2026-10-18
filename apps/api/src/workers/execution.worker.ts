import { Worker } from "bullmq";
import { executeCpp } from "../adapters/cpp.adapter.js";
import { executeJava } from "../adapters/java.adapter.js";
import { env } from "../config/env.js";
import { containerCleanupConfig } from "../config/sandbox.js";
import prisma from "../lib/prisma.js";
import connection from "../lib/redis.js";
import type { ExecutionJobData } from "../queues/execution.job.js";
import { executionQueue } from "../queues/execution.queue.js";
import { cleanupLeakedContainers, createDockerCleanupCli } from "../runtime/container-cleanup.js";
import { describeRetention, isRetentionEnabled, pruneExecutionHistory } from "../services/execution-retention.js";
import { getErrorMessage } from "../utils/errors.js";
import { handleFailedExecutionJob, processExecutionJob, type ExecutionJobDeps } from "./execution.processor.js";
import { reconcileOrphanedExecutions } from "./execution.reconciler.js";
import { startPeriodicTask } from "./periodic-task.js";
import { exitOnShutdownSignal, runShutdownSteps } from "../lib/shutdown.js";

const deps: ExecutionJobDeps = {
  executions: prisma.execution,
  executors: {
    cpp: (code, input) => executeCpp(code, input),
    java: (code, input) => executeJava(code, input),
  },
};

const worker = new Worker<ExecutionJobData>("execution-queue", (job) => processExecutionJob(job, deps), {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
});
console.log(`Execution worker started (concurrency ${env.WORKER_CONCURRENCY})`);

worker.on("completed", (job) => console.log(`Job ${job.id} completed`));
worker.on("failed", (job, error) => void handleFailedExecutionJob(job, error, deps));
worker.on("error", (error) => console.error(`Worker error: ${getErrorMessage(error)}`));

// Removes execution containers leaked by a previous worker that died mid-run. Logs its result; never rejects.
void cleanupLeakedContainers({ docker: createDockerCleanupCli(), ...containerCleanupConfig });

const reconciler = startPeriodicTask(
  "Execution reconciliation",
  async () => {
    const summary = await reconcileOrphanedExecutions({
      store: prisma.execution,
      queue: executionQueue,
      graceMs: env.EXECUTION_RECONCILE_GRACE_MS,
    });
    if (summary.markedFailed || summary.skipped || summary.errors) console.log(`Execution reconciliation: ${JSON.stringify(summary)}`);
  },
  env.EXECUTION_RECONCILE_INTERVAL_MS,
);

const retentionLimits = { maxPerUser: env.EXECUTION_HISTORY_MAX_PER_USER, maxTotal: env.EXECUTION_HISTORY_MAX_TOTAL };
console.log(describeRetention(retentionLimits));
const retention = isRetentionEnabled(retentionLimits)
  ? startPeriodicTask(
      "Execution history retention",
      async () => {
        const summary = await pruneExecutionHistory(prisma, retentionLimits);
        if (summary.deletedPerUser || summary.deletedTotal) console.log(`Execution history retention: ${JSON.stringify(summary)}`);
      },
      env.EXECUTION_RETENTION_INTERVAL_MS,
    )
  : undefined;

// The deadline covers worker.close(), which waits for running jobs; a job cut off by it is retried after its lock
// expires, and its container is still ended by the in-container timeout.
exitOnShutdownSignal({
  name: "worker",
  timeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
  shutdown: () =>
    runShutdownSteps([
      { name: "stop reconciliation", run: () => reconciler.stop() },
      { name: "stop history retention", run: async () => retention?.stop() },
      { name: "close worker", run: () => worker.close() },
      { name: "close queue", run: () => executionQueue.close() },
      { name: "disconnect Prisma", run: () => prisma.$disconnect() },
      // Queue and Worker share this connection, so closing them does not close it.
      { name: "close Redis connection", run: () => (connection as unknown as { quit(): Promise<unknown> }).quit() },
    ]),
});
