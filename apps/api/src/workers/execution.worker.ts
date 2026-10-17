import { Worker } from "bullmq";
import { executeCpp } from "../adapters/cpp.adapter.js";
import prisma from "../lib/prisma.js";
import connection from "../lib/redis.js";
import { formatExecutionOutput, toExecutionStatus, type ExecutionStatus } from "../runtime/execution-result.js";

interface ExecutionJobData {
  executionId: string;
}

const worker = new Worker<ExecutionJobData>(
  "execution-queue",
  async (job) => {
    const { executionId } = job.data;
    console.log("Processing execution:", executionId);

    await prisma.execution.update({ where: { id: executionId }, data: { status: "RUNNING" } });
    const execution = await prisma.execution.findUnique({ where: { id: executionId } });
    if (!execution) throw new Error("Execution not found");

    let status: ExecutionStatus = "COMPLETED";
    let output = "";

    if (execution.language === "cpp") {
      const result = await executeCpp(execution.code, execution.input || "");
      status = toExecutionStatus(result.outcome);
      output = formatExecutionOutput(result);
      if (result.outcome === "INFRASTRUCTURE_ERROR") console.error(`Infrastructure error for ${executionId}: ${result.message}`);
    } else {
      status = "FAILED";
      output = "Language not supported";
    }

    await prisma.execution.update({ where: { id: executionId }, data: { status, output } });
    console.log(`${status}: ${executionId}`);
  },
  { connection },
);

worker.on("completed", (job) => console.log(`Job ${job.id} completed`));
worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed`);
  console.error(error);
});
