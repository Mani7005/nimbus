import type { ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

// BullMQ currently resolves a different compatible ioredis patch version.
// The client API is intentionally shared; this bridges the duplicate package types.
const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
}) as unknown as ConnectionOptions;

export default connection;
