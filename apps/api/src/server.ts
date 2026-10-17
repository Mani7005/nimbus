import app from "./app.js";
import { env } from "./config/env.js";
import { closeHttpServer } from "./lib/http-shutdown.js";
import prisma from "./lib/prisma.js";
import connection from "./lib/redis.js";
import { exitOnShutdownSignal, runShutdownSteps } from "./lib/shutdown.js";
import { executionQueue } from "./queues/execution.queue.js";

const server = app.listen(env.PORT, () => {
  console.log("=================================");
  console.log("🚀 Nimbus API Running");
  console.log(`🌐 http://localhost:${env.PORT}`);
  console.log(`🌍 ${env.NODE_ENV}`);
  console.log("=================================");
});

// In-flight requests get API_SHUTDOWN_TIMEOUT_MS; the remaining steps get a few more seconds before the hard deadline.
exitOnShutdownSignal({
  name: "API",
  timeoutMs: env.API_SHUTDOWN_TIMEOUT_MS + 5000,
  shutdown: () =>
    runShutdownSteps(
      [
        { name: "stop HTTP server", run: () => closeHttpServer(server, env.API_SHUTDOWN_TIMEOUT_MS) },
        { name: "close queue", run: () => executionQueue.close() },
        { name: "disconnect Prisma", run: () => prisma.$disconnect() },
        // Shared by the queue and the Redis rate-limit store; closing the queue does not close it.
        { name: "close Redis connection", run: () => (connection as unknown as { quit(): Promise<unknown> }).quit() },
      ],
      console,
      "API",
    ),
});
