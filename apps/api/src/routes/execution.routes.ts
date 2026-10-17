import { Router } from "express";

import {
  execute,
  getExecutionById,
  getExecutions,
  removeExecution,
} from "../controllers/execution.controller.js";

import { authenticate } from "../middleware/auth.middleware.js";
import { executionRateLimit } from "../middleware/rate-limiters.js";
import { validateBody, validateParams, validateQuery } from "../middleware/validate.middleware.js";
import { executeSchema, executionIdParamsSchema, executionListQuerySchema } from "../validators/execution.validator.js";

const router = Router();

router.post("/", authenticate, executionRateLimit, validateBody(executeSchema), execute);

router.get("/", authenticate, validateQuery(executionListQuerySchema), getExecutions);

router.get("/:id", authenticate, validateParams(executionIdParamsSchema), getExecutionById);

router.delete("/:id", authenticate, validateParams(executionIdParamsSchema), removeExecution);

export default router;