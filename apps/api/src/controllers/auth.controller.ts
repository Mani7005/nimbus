import { Request, Response } from "express";
import { registerSchema } from "../validators/auth.validator.js";
import { registerUser, loginUser } from "../services/auth.service.js";
import { generateToken } from "../utils/jwt.js";
import prisma from "../lib/prisma.js";
import { AuthRequest } from "../middleware/auth.middleware.js";

export const register = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { email, password } = registerSchema.parse(req.body);

    const user = await registerUser(email, password);

    res.status(201).json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

export const login = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { email, password } = req.body;

    const user = await loginUser(email, password);

    const token = generateToken(user.id);

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error: any) {
    res.status(401).json({
      success: false,
      message: error.message,
    });
  }
};

export const me = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {

  const user = await prisma.user.findUnique({
    where: {
      id: req.userId,
    },
    select: {
      id: true,
      email: true,
      createdAt: true,
    },
  });

  res.status(200).json({
    success: true,
    user,
  });

};