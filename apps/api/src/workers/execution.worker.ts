import { Worker } from "bullmq";
import connection from "../lib/redis.js";
import prisma from "../lib/prisma.js";
import { executeCpp } from "../adapters/cpp.adapter.js";

const worker = new Worker(
  "execution-queue",
  async (job) => {
    const { executionId } = job.data;

    console.log("📦 Processing:", executionId);

    // Mark execution as RUNNING
    await prisma.execution.update({
      where: {
        id: executionId,
      },
      data: {
        status: "RUNNING",
      },
    });

    // Fetch execution
    const execution = await prisma.execution.findUnique({
      where: {
        id: executionId,
      },
    });

    if (!execution) {
      throw new Error("Execution not found");
    }

    console.log("=================================");
    console.log("📄 Execution Details");
    console.log("Language:", execution.language);
    console.log("Input:", JSON.stringify(execution.input));
    console.log("Code:");
    console.log(execution.code);
    console.log("=================================");

    let status = "COMPLETED";
    let output = "";

    switch (execution.language) {
      case "cpp": {
        console.log("🚀 Calling executeCpp...");

        const result = await executeCpp(
          execution.code,
          execution.input || ""
        );

        console.log("📤 executeCpp Result:");
        console.log(result);

        output = result.stderr || result.stdout;

        if (result.stderr) {
          if (result.stderr.includes("Timed Out")) {
            status = "TIMEOUT";
          } else {
            status = "FAILED";
          }
        }

        break;
      }

      default: {
        status = "FAILED";
        output = "Language not supported";
      }
    }

    await prisma.execution.update({
      where: {
        id: executionId,
      },
      data: {
        status,
        output,
      },
    });

    console.log(`✅ ${status}: ${executionId}`);
  },
  {
    connection,
  }
);

worker.on("completed", (job) => {
  console.log(`🎉 Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed`);
  console.error(err);
});