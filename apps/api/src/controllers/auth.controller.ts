import type { Request, Response } from "express";
import prisma from "../lib/prisma.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { DuplicateEmailError, InvalidCredentialsError, loginUser, registerUser } from "../services/auth.service.js";
import { generateToken } from "../utils/jwt.js";
import type { LoginRequestBody, RegisterRequestBody } from "../validators/auth.validator.js";

export const DUPLICATE_EMAIL_MESSAGE = "An account with this email already exists";
export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

function authResponse(user: { id: string; email: string }, token: string) {
  return { success: true, token, user: { id: user.id, email: user.email } };
}

// Bodies are validated and emails normalized by validateBody; unexpected errors go to the JSON error handler.
export async function register(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as RegisterRequestBody;
  try {
    const user = await registerUser(email, password);
    res.status(201).json(authResponse(user, generateToken(user.id)));
  } catch (error) {
    if (!(error instanceof DuplicateEmailError)) throw error;
    res.status(409).json({ success: false, message: DUPLICATE_EMAIL_MESSAGE });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginRequestBody;
  try {
    const user = await loginUser(email, password);
    res.status(200).json(authResponse(user, generateToken(user.id)));
  } catch (error) {
    if (!(error instanceof InvalidCredentialsError)) throw error;
    res.status(401).json({ success: false, message: INVALID_CREDENTIALS_MESSAGE });
  }
}

export async function me(req: AuthRequest, res: Response): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, createdAt: true },
  });

  res.status(200).json({ success: true, user });
}
