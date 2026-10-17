import type { NextFunction, Request, Response } from "express";

export const INTERNAL_ERROR_MESSAGE = "Internal server error";

// Fixed messages for express.json() (body-parser) failures; body-parser's own messages can echo request content.
const BODY_PARSER_ERRORS: Record<string, { status: number; message: string }> = {
  "entity.parse.failed": { status: 400, message: "Malformed JSON request body" },
  "entity.too.large": { status: 413, message: "Request body too large" },
  "encoding.unsupported": { status: 415, message: "Unsupported request body encoding" },
  "charset.unsupported": { status: 415, message: "Unsupported request body charset" },
  "request.aborted": { status: 400, message: "Request aborted" },
  "request.size.invalid": { status: 400, message: "Request body size does not match Content-Length" },
};

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ success: false, message: "Route not found" });
}

/**
 * Final error handler. Request-body errors get a fixed 4xx message; anything else is logged with its stack and
 * answered with a generic 500. Responses never contain stack traces or internal error messages, in any NODE_ENV.
 */
export function errorHandler(logger: Pick<Console, "error"> = console) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    const type = typeof error === "object" && error !== null ? (error as { type?: unknown }).type : undefined;
    const known = typeof type === "string" ? BODY_PARSER_ERRORS[type] : undefined;
    if (known && !res.headersSent) {
      res.status(known.status).json({ success: false, message: known.message });
      return;
    }

    // req.path excludes the query string, which could carry credentials.
    logger.error(`Unhandled error on ${req.method} ${req.path}:`, error);
    // A response already under way cannot be replaced; Express's default handler closes the connection.
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({ success: false, message: INTERNAL_ERROR_MESSAGE });
  };
}
