import dotenv from "dotenv";
import {
  ConfigError,
  readEnumSetting,
  readIntSetting,
  readOriginListSetting,
  readSecretSetting,
  readUrlSetting,
  type Source,
} from "./settings.js";

dotenv.config();

/** HS256 signing secret length; generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. */
export const MIN_JWT_SECRET_LENGTH = 32;
const NODE_ENVS = ["development", "production", "test"] as const;
// "memory" keeps rate-limit counters inside one process: only correct when exactly one API instance runs.
const RATE_LIMIT_STORES = ["redis", "memory"] as const;
const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The Vite dev server; the only origin allowed by default outside production. */
export const DEVELOPMENT_CORS_ORIGIN = "http://localhost:5173";

/**
 * Defaults that differ by NODE_ENV. Production gets conservative limits for a public demo with a small database;
 * development and test keep the original behaviour. Every value can still be set explicitly.
 */
export const EXECUTION_DEFAULTS = {
  development: { maxOutputBytes: 64 * 1024, rateLimit: 20, maxActivePerUser: 3, maxActiveTotal: 0, historyMaxPerUser: 0, historyMaxTotal: 0 },
  production: { maxOutputBytes: 16 * 1024, rateLimit: 10, maxActivePerUser: 2, maxActiveTotal: 30, historyMaxPerUser: 50, historyMaxTotal: 1000 },
};

/** Validates every setting and throws one ConfigError listing all problems, so the process never starts misconfigured. */
export function loadEnv(source: Source) {
  const problems: string[] = [];
  const read = <T>(setting: () => T): T => {
    try {
      return setting();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      return undefined as T;
    }
  };

  const NODE_ENV = read(() => readEnumSetting("NODE_ENV", NODE_ENVS, "development", source));
  const production = NODE_ENV === "production";
  const defaults = production ? EXECUTION_DEFAULTS.production : EXECUTION_DEFAULTS.development;

  const config = {
    PORT: read(() => readIntSetting("PORT", 3000, 1, 65535, source)),
    DATABASE_URL: read(() => readUrlSetting("DATABASE_URL", ["postgresql:", "postgres:"], source)),
    REDIS_URL: read(() => readUrlSetting("REDIS_URL", ["redis:", "rediss:"], source)),
    JWT_SECRET: read(() => readSecretSetting("JWT_SECRET", MIN_JWT_SECRET_LENGTH, source)),
    NODE_ENV,
    // Browser origins allowed to call the API (the web app). Required in production, where only https: is accepted.
    CORS_ORIGINS: read(() =>
      readOriginListSetting("CORS_ORIGINS", production ? { httpsOnly: true } : { fallback: [DEVELOPMENT_CORS_ORIGIN] }, source),
    ),
    EXECUTION_COMPILE_TIMEOUT_MS: read(() => readIntSetting("EXECUTION_COMPILE_TIMEOUT_MS", 30_000, 1000, 5 * MINUTE_MS, source)),
    EXECUTION_RUN_TIMEOUT_MS: read(() => readIntSetting("EXECUTION_RUN_TIMEOUT_MS", 10_000, 100, 2 * MINUTE_MS, source)),
    // Per stream (stdout, stderr); a stored output holds at most the program's two streams plus the compiler's two.
    EXECUTION_MAX_OUTPUT_BYTES: read(() => readIntSetting("EXECUTION_MAX_OUTPUT_BYTES", defaults.maxOutputBytes, 1024, 10 * MIB, source)),
    EXECUTION_ENQUEUE_TIMEOUT_MS: read(() => readIntSetting("EXECUTION_ENQUEUE_TIMEOUT_MS", 5000, 10, MINUTE_MS, source)),
    EXECUTION_RECONCILE_GRACE_MS: read(() => readIntSetting("EXECUTION_RECONCILE_GRACE_MS", 5 * MINUTE_MS, MINUTE_MS, 7 * DAY_MS, source)),
    EXECUTION_RECONCILE_INTERVAL_MS: read(() => readIntSetting("EXECUTION_RECONCILE_INTERVAL_MS", MINUTE_MS, 5000, DAY_MS, source)),
    EXECUTION_MAX_ACTIVE_PER_USER: read(() => readIntSetting("EXECUTION_MAX_ACTIVE_PER_USER", defaults.maxActivePerUser, 1, 100, source)),
    // PENDING + RUNNING executions across all users; submissions beyond it get 503. 0 disables the global cap.
    EXECUTION_MAX_ACTIVE_TOTAL: read(() => readIntSetting("EXECUTION_MAX_ACTIVE_TOTAL", defaults.maxActiveTotal, 0, 100_000, source)),
    EXECUTION_RATE_LIMIT: read(() => readIntSetting("EXECUTION_RATE_LIMIT", defaults.rateLimit, 1, 10_000, source)),
    EXECUTION_RATE_WINDOW_MS: read(() => readIntSetting("EXECUTION_RATE_WINDOW_MS", MINUTE_MS, 1000, DAY_MS, source)),
    // Finished executions kept per user and in total; older ones are deleted by the worker. 0 keeps everything.
    EXECUTION_HISTORY_MAX_PER_USER: read(() => readIntSetting("EXECUTION_HISTORY_MAX_PER_USER", defaults.historyMaxPerUser, 0, 100_000, source)),
    EXECUTION_HISTORY_MAX_TOTAL: read(() => readIntSetting("EXECUTION_HISTORY_MAX_TOTAL", defaults.historyMaxTotal, 0, 10_000_000, source)),
    EXECUTION_RETENTION_INTERVAL_MS: read(() => readIntSetting("EXECUTION_RETENTION_INTERVAL_MS", 5 * MINUTE_MS, MINUTE_MS, DAY_MS, source)),
    AUTH_LOGIN_RATE_LIMIT: read(() => readIntSetting("AUTH_LOGIN_RATE_LIMIT", 10, 1, 10_000, source)),
    AUTH_LOGIN_RATE_WINDOW_MS: read(() => readIntSetting("AUTH_LOGIN_RATE_WINDOW_MS", 15 * MINUTE_MS, 1000, DAY_MS, source)),
    AUTH_REGISTER_RATE_LIMIT: read(() => readIntSetting("AUTH_REGISTER_RATE_LIMIT", 5, 1, 10_000, source)),
    AUTH_REGISTER_RATE_WINDOW_MS: read(() => readIntSetting("AUTH_REGISTER_RATE_WINDOW_MS", 60 * MINUTE_MS, 1000, DAY_MS, source)),
    RATE_LIMIT_STORE: read(() => readEnumSetting("RATE_LIMIT_STORE", RATE_LIMIT_STORES, "redis", source)),
    // Number of reverse proxies in front of the API; 0 uses the socket address as the client IP for per-IP limits.
    TRUST_PROXY: read(() => readIntSetting("TRUST_PROXY", 0, 0, 10, source)),
    // Each concurrent job may run a compile container (512 MB by default) and a run container.
    WORKER_CONCURRENCY: read(() => readIntSetting("WORKER_CONCURRENCY", 1, 1, 32, source)),
    // How long in-flight HTTP requests may take to finish after a shutdown signal.
    API_SHUTDOWN_TIMEOUT_MS: read(() => readIntSetting("API_SHUTDOWN_TIMEOUT_MS", 10_000, 1000, 2 * MINUTE_MS, source)),
    // Hard deadline for the whole worker shutdown, including waiting for running jobs.
    WORKER_SHUTDOWN_TIMEOUT_MS: read(() => readIntSetting("WORKER_SHUTDOWN_TIMEOUT_MS", MINUTE_MS, 5000, 10 * MINUTE_MS, source)),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

export type Env = ReturnType<typeof loadEnv>;

export const env: Env = loadEnv(process.env);
