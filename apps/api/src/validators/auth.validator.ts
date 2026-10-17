import { z } from "zod";

// bcrypt only uses the first 72 bytes of a password; longer ones would silently match on their first 72 bytes.
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;
// Bounds login input without rejecting accounts registered before the byte limit; bcrypt ignores bytes past 72.
const MAX_LOGIN_PASSWORD_LENGTH = 1024;
const MAX_EMAIL_LENGTH = 254;

/** Trimmed and lower-cased, so registration and login always use the same stored form. */
const normalizedEmail = z.string().trim().toLowerCase().pipe(z.email().max(MAX_EMAIL_LENGTH));

export const registerSchema = z.object({
  email: normalizedEmail,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .refine((password) => Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES, {
      message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes`,
    }),
});

export const loginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(1).max(MAX_LOGIN_PASSWORD_LENGTH),
});

export type RegisterRequestBody = z.infer<typeof registerSchema>;
export type LoginRequestBody = z.infer<typeof loginSchema>;
