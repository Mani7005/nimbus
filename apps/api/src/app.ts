import express from "express";
import cors from "cors";

import executionRoutes from "./routes/execution.routes.js";
import healthRoutes from "./routes/health.routes.js";
import authRoutes from "./routes/auth.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { env } from "./config/env.js";

const app = express();

// Decides what req.ip (used by the per-IP rate limits) trusts from X-Forwarded-For; 0 trusts no proxy.
app.set("trust proxy", env.TRUST_PROXY);

app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json());

app.use("/execute", executionRoutes);

app.use("/health", healthRoutes);

app.use("/auth", authRoutes);

// Must stay last: unmatched routes, then every error passed on by routes and middleware.
app.use(notFoundHandler);

app.use(errorHandler());

export default app;