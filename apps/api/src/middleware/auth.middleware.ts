import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AuthRequest extends Request {
  userId?: string;
}

// "Bearer" (case-insensitive scheme, RFC 7235), one space, then a compact JWT: three base64url segments.
const BEARER_TOKEN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

function sendUnauthorized(res: Response, message: string): void {
  res.status(401).json({ success: false, message });
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    sendUnauthorized(res, "Token missing");
    return;
  }

  const match = BEARER_TOKEN.exec(authHeader);
  if (!match) {
    sendUnauthorized(res, "Invalid token");
    return;
  }

  let payload: string | jwt.JwtPayload;
  try {
    // Pinned to the algorithm generateToken signs with.
    payload = jwt.verify(match[1], env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    sendUnauthorized(res, "Invalid token");
    return;
  }

  const userId = typeof payload === "object" ? payload.userId : undefined;
  if (typeof userId !== "string" || userId === "") {
    sendUnauthorized(res, "Invalid token");
    return;
  }

  req.userId = userId;
  next();
};
