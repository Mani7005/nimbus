import { Router } from "express";

import {
  execute,
  getExecutionById,
  getExecutions,
  removeExecution,
} from "../controllers/execution.controller.js";

import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

router.post("/", authenticate, execute);

router.get("/", authenticate, getExecutions);

router.get("/:id", authenticate, getExecutionById);

router.delete("/:id", authenticate, removeExecution);

export default router;