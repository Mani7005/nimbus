import { Queue } from "bullmq";
import connection from "../lib/redis.js";
import { EXECUTION_JOB_OPTIONS } from "./execution.job.js";

export const executionQueue = new Queue(
  "execution-queue",
  {
    connection,
    defaultJobOptions: EXECUTION_JOB_OPTIONS,
  }
);