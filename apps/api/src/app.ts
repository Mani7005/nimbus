import express from "express";
import cors from "cors";

import executionRoutes from "./routes/execution.routes.js";
import healthRoutes from "./routes/health.routes.js";
import authRoutes from "./routes/auth.routes.js";

const app = express();

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

export default app;