import IORedis from "ioredis";
import { env } from "../config/env.js";

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export default connection;