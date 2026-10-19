import type { NextFunction, Request, Response } from "express";
import { getErrorMessage } from "../utils/errors.js";

export interface RateLimitHit {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

/** Fixed-window counter. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/**
 * Counters in this process only. Correct only when a single API instance serves all traffic; with several instances
 * each would allow the full limit. Expired windows are swept at most once a minute; at maxKeys the oldest entries
 * are dropped (resetting those counters) so memory stays bounded.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.now();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.delete(key);
      window = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, window);
    }
    window.count++;
    return { count: window.count, resetMs: window.resetAt - now };
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep >= 60_000 || this.windows.size >= this.maxKeys) {
      this.lastSweep = now;
      for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}

// Atomic increment that starts the window on the first hit; repairs a key left without an expiry.
const REDIS_HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Counters shared by every API instance using the same Redis. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly client: RedisEvalClient,
    private readonly prefix = "nimbus:ratelimit:",
  ) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const [count, ttl] = (await this.client.eval(REDIS_HIT_SCRIPT, 1, `${this.prefix}${key}`, windowMs)) as [number, number];
    return { count: Number(count), resetMs: Number(ttl) };
  }
}

export interface RateLimitOptions {
  /** Separates counters of different limiters in a shared store. */
  name: string;
  max: number;
  windowMs: number;
  message: string;
  /** The client identity to count; requests without one are not limited. */
  key: (req: Request) => string | undefined;
  store: RateLimitStore;
  /** A store slower than this is treated as unavailable. */
  timeoutMs?: number;
  logger?: Pick<Console, "error">;
}

class StoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`rate-limit store did not respond within ${timeoutMs}ms`);
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreTimeoutError(timeoutMs)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Answers over-limit requests with 429 `{ success: false, message }` and a Retry-After header. If the store fails
 * or times out the request is allowed and the failure logged: an outage must not lock every user out of login.
 */
export function rateLimit(options: RateLimitOptions) {
  const { name, max, windowMs, message, key, store, timeoutMs = 1000, logger = console } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identity = key(req);
    if (!identity) {
      next();
      return;
    }

    let hit: RateLimitHit;
    try {
      hit = await withTimeout(store.hit(`${name}:${identity}`, windowMs), timeoutMs);
    } catch (error) {
      logger.error(`Rate limiter "${name}" unavailable, allowing request: ${getErrorMessage(error)}`);
      next();
      return;
    }

    if (hit.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(hit.resetMs / 1000))));
      res.status(429).json({ success: false, message });
      return;
    }
    next();
  };
}
