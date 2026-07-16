import { Queue } from "bullmq";
import connection from "../lib/redis.js";

export const executionQueue = new Queue(
  "execution-queue",
  {
    connection,
  }
);