import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import {
  ExecutionUnavailableError,
  createExecution,
  deleteExecution,
  getExecution,
  getUserExecutions,
} from "../services/execution.service.js";
import { ActiveExecutionLimitError } from "../services/execution-limit.js";
import type { ExecuteRequestBody, ExecutionListQuery } from "../validators/execution.validator.js";

export async function execute(req: AuthRequest, res: Response): Promise<void> {
  const { language, code, input } = req.body as ExecuteRequestBody;
  try {
    const execution = await createExecution(req.userId!, language, code, input ?? "");
    res.status(201).json({ success: true, execution });
  } catch (error) {
    if (error instanceof ActiveExecutionLimitError) {
      res.status(429).json({
        success: false,
        message: `You already have ${error.limit} unfinished executions. Wait for one to finish before submitting another.`,
      });
      return;
    }
    if (!(error instanceof ExecutionUnavailableError)) throw error;
    res.status(503).json({ success: false, message: "Execution service unavailable. Please try again." });
  }
}

// Same response whether the execution is missing or owned by someone else, so ownership is not revealed.
function sendExecutionNotFound(res: Response): void {
  res.status(404).json({ success: false, message: "Execution not found" });
}

export async function getExecutionById(req: AuthRequest, res: Response): Promise<void> {
  const execution = await getExecution(req.params.id as string, req.userId!);
  if (!execution) {
    sendExecutionNotFound(res);
    return;
  }

  res.json({ success: true, execution });
}

export async function getExecutions(req: AuthRequest, res: Response): Promise<void> {
  const page = await getUserExecutions(req.userId!, res.locals.query as ExecutionListQuery);
  if (!page) {
    // Same validation format as a malformed cursor; another user's id is indistinguishable from a nonexistent one.
    res.status(400).json({ success: false, message: "cursor: Invalid cursor" });
    return;
  }

  res.json({ success: true, executions: page.executions, nextCursor: page.nextCursor });
}

export async function removeExecution(req: AuthRequest, res: Response): Promise<void> {
  const deleted = await deleteExecution(req.params.id as string, req.userId!);
  if (!deleted) {
    sendExecutionNotFound(res);
    return;
  }

  res.json({ success: true, message: "Execution deleted successfully" });
}
