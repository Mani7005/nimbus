import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import prisma from "../lib/prisma.js";

const SALT_ROUNDS = 10;

/** The email is already registered, found either before insert or as a unique-constraint race (P2002). */
export class DuplicateEmailError extends Error {
  constructor() {
    super("Email already registered");
    this.name = "DuplicateEmailError";
  }
}

/** Same error for an unknown email and a wrong password, so callers cannot tell them apart. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

// Compared against when the email is unknown, so both failure paths spend the same bcrypt time.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hash(randomUUID(), SALT_ROUNDS));

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** Expects a normalized email (see registerSchema). */
export async function registerUser(email: string, password: string) {
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) throw new DuplicateEmailError();

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    return await prisma.user.create({ data: { email, password: hashedPassword } });
  } catch (error) {
    // Another registration for the same email won between the lookup and the insert.
    if (isUniqueConstraintError(error)) throw new DuplicateEmailError();
    throw error;
  }
}

/** Expects a normalized email (see loginSchema). */
export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  const isMatch = await bcrypt.compare(password, user ? user.password : await getDummyHash());
  if (!user || !isMatch) throw new InvalidCredentialsError();
  return user;
}
