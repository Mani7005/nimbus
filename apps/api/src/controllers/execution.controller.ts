import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware.js";
import {
  createExecution,
  getExecution,
  getUserExecutions,
  deleteExecution,
} from "../services/execution.service.js";

export const execute = async (
  req: AuthRequest,
  res: Response
) => {
  const { language, code } = req.body;

  const execution = await createExecution(
    req.userId!,
    language,
    code
  );

  res.status(201).json({
    success: true,
    execution,
  });
};

export async function getExecutionById(
  req: AuthRequest,
  res: Response
) {
  const execution = await getExecution(req.params.id as string);

  if (!execution) {
    return res.status(404).json({
      success: false,
      message: "Execution not found",
    });
  }

  res.json({
    success: true,
    execution,
  });
}

export async function getExecutions(
  req: AuthRequest,
  res: Response
) {
  const executions = await getUserExecutions(req.userId!);

  res.json({
    success: true,
    executions,
  });
}

export async function removeExecution(
  req: AuthRequest,
  res: Response
) {
  await deleteExecution(req.params.id as string);

  res.json({
    success: true,
    message: "Execution deleted successfully",
  });
}