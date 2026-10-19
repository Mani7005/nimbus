import type { Request } from "express";
import { env } from "../config/env.js";
import type { AuthRequest } from "./auth.middleware.js";
import { MemoryRateLimitStore, RedisRateLimitStore, rateLimit, type RateLimitStore, type RedisEvalClient } from "./rate-limit.middleware.js";

export const LOGIN_RATE_LIMIT_MESSAGE = "Too many login attempts. Please try again later.";
export const REGISTER_RATE_LIMIT_MESSAGE = "Too many registration attempts. Please try again later.";
export const EXECUTION_RATE_LIMIT_MESSAGE = "Too many execution requests. Please wait before submitting again.";

// Redis is imported only when selected, so the in-memory configuration never opens a Redis connection.
const store: RateLimitStore =
  env.RATE_LIMIT_STORE === "redis"
    ? new RedisRateLimitStore((await import("../lib/redis.js")).default as unknown as RedisEvalClient)
    : new MemoryRateLimitStore();

// With TRUST_PROXY = 0, req.ip is the socket address; behind proxies it must be configured or all clients share one IP.
const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress;

export const loginRateLimit = rateLimit({
  name: "login",
  max: env.AUTH_LOGIN_RATE_LIMIT,
  windowMs: env.AUTH_LOGIN_RATE_WINDOW_MS,
  message: LOGIN_RATE_LIMIT_MESSAGE,
  key: clientIp,
  store,
});

export const registerRateLimit = rateLimit({
  name: "register",
  max: env.AUTH_REGISTER_RATE_LIMIT,
  windowMs: env.AUTH_REGISTER_RATE_WINDOW_MS,
  message: REGISTER_RATE_LIMIT_MESSAGE,
  key: clientIp,
  store,
});

/** Must run after authenticate. */
export const executionRateLimit = rateLimit({
  name: "execute",
  max: env.EXECUTION_RATE_LIMIT,
  windowMs: env.EXECUTION_RATE_WINDOW_MS,
  message: EXECUTION_RATE_LIMIT_MESSAGE,
  key: (req) => (req as AuthRequest).userId,
  store,
});
