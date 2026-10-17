import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";

export function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

function sendValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({ success: false, message: formatValidationError(error) });
}

/** Replaces req.body with the parsed value, dropping unknown keys. */
export function validateBody(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      sendValidationError(res, result.error);
      return;
    }

    req.body = result.data;
    next();
  };
}

/** Stores the parsed query in res.locals.query; Express 5's req.query is read-only. */
export function validateQuery(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      sendValidationError(res, result.error);
      return;
    }

    res.locals.query = result.data;
    next();
  };
}

export function validateParams(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      sendValidationError(res, result.error);
      return;
    }

    next();
  };
}
