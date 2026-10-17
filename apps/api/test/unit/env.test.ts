import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_JWT_SECRET_LENGTH, loadEnv } from "../../src/config/env.js";
import { ConfigError } from "../../src/config/settings.js";

const SECRET = "s".repeat(MIN_JWT_SECRET_LENGTH);
const VALID = {
  DATABASE_URL: "postgresql://postgres:hunter2@localhost:5432/nimbus",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: SECRET,
};

function problemsFor(source: Record<string, string | undefined>): readonly string[] {
  try {
    loadEnv(source);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.problems;
  }
  assert.fail("expected loadEnv to throw");
}

describe("loadEnv", () => {
  it("applies the existing defaults when only the required settings are given", () => {
    assert.deepEqual(loadEnv(VALID), {
      ...VALID,
      PORT: 3000,
      NODE_ENV: "development",
      EXECUTION_COMPILE_TIMEOUT_MS: 30000,
      EXECUTION_RUN_TIMEOUT_MS: 10000,
      EXECUTION_MAX_OUTPUT_BYTES: 64 * 1024,
      EXECUTION_ENQUEUE_TIMEOUT_MS: 5000,
      EXECUTION_RECONCILE_GRACE_MS: 300000,
      EXECUTION_RECONCILE_INTERVAL_MS: 60000,
      EXECUTION_MAX_ACTIVE_PER_USER: 3,
      EXECUTION_RATE_LIMIT: 20,
      EXECUTION_RATE_WINDOW_MS: 60000,
      AUTH_LOGIN_RATE_LIMIT: 10,
      AUTH_LOGIN_RATE_WINDOW_MS: 900000,
      AUTH_REGISTER_RATE_LIMIT: 5,
      AUTH_REGISTER_RATE_WINDOW_MS: 3600000,
      RATE_LIMIT_STORE: "redis",
      TRUST_PROXY: 0,
      WORKER_CONCURRENCY: 1,
      API_SHUTDOWN_TIMEOUT_MS: 10000,
      WORKER_SHUTDOWN_TIMEOUT_MS: 60000,
    });
  });

  for (const [name, value, expected] of [
    ["API_SHUTDOWN_TIMEOUT_MS", "500", "API_SHUTDOWN_TIMEOUT_MS must be between 1000 and 120000, got 500"],
    ["WORKER_SHUTDOWN_TIMEOUT_MS", "1000", "WORKER_SHUTDOWN_TIMEOUT_MS must be between 5000 and 600000, got 1000"],
    ["WORKER_SHUTDOWN_TIMEOUT_MS", "-1", 'WORKER_SHUTDOWN_TIMEOUT_MS must be a whole number, got "-1"'],
  ] as const) {
    it(`rejects ${name}=${value}`, () => {
      assert.deepEqual(problemsFor({ ...VALID, [name]: value }), [expected]);
    });
  }

  it("uses the in-memory rate-limit store only when explicitly configured", () => {
    assert.equal(loadEnv(VALID).RATE_LIMIT_STORE, "redis");
    assert.equal(loadEnv({ ...VALID, RATE_LIMIT_STORE: "memory" }).RATE_LIMIT_STORE, "memory");
  });

  for (const [name, value, expected] of [
    ["EXECUTION_MAX_ACTIVE_PER_USER", "0", "EXECUTION_MAX_ACTIVE_PER_USER must be between 1 and 100, got 0"],
    ["EXECUTION_RATE_LIMIT", "-1", 'EXECUTION_RATE_LIMIT must be a whole number, got "-1"'],
    ["EXECUTION_RATE_WINDOW_MS", "500", "EXECUTION_RATE_WINDOW_MS must be between 1000 and 86400000, got 500"],
    ["AUTH_LOGIN_RATE_LIMIT", "0", "AUTH_LOGIN_RATE_LIMIT must be between 1 and 10000, got 0"],
    ["AUTH_REGISTER_RATE_WINDOW_MS", "abc", 'AUTH_REGISTER_RATE_WINDOW_MS must be a whole number, got "abc"'],
    ["RATE_LIMIT_STORE", "postgres", 'RATE_LIMIT_STORE must be one of redis, memory, got "postgres"'],
    ["TRUST_PROXY", "true", 'TRUST_PROXY must be a whole number, got "true"'],
    ["WORKER_CONCURRENCY", "0", "WORKER_CONCURRENCY must be between 1 and 32, got 0"],
    ["WORKER_CONCURRENCY", "33", "WORKER_CONCURRENCY must be between 1 and 32, got 33"],
    ["WORKER_CONCURRENCY", "2.5", 'WORKER_CONCURRENCY must be a whole number, got "2.5"'],
  ] as const) {
    it(`rejects ${name}=${value}`, () => {
      assert.deepEqual(problemsFor({ ...VALID, [name]: value }), [expected]);
    });
  }

  it("accepts worker concurrency within range", () => {
    assert.equal(loadEnv({ ...VALID, WORKER_CONCURRENCY: "4" }).WORKER_CONCURRENCY, 4);
  });

  it("parses valid overrides", () => {
    const env = loadEnv({ ...VALID, PORT: "8080", NODE_ENV: "production", EXECUTION_RUN_TIMEOUT_MS: "15000", REDIS_URL: "rediss://cache:6380" });
    assert.equal(env.PORT, 8080);
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.EXECUTION_RUN_TIMEOUT_MS, 15000);
    assert.equal(env.REDIS_URL, "rediss://cache:6380");
  });

  it("reports every missing required setting at once", () => {
    assert.deepEqual(problemsFor({}), ["DATABASE_URL is required", "REDIS_URL is required", "JWT_SECRET is required"]);
  });

  it("treats blank values as missing", () => {
    assert.deepEqual(problemsFor({ ...VALID, JWT_SECRET: "   " }), ["JWT_SECRET is required"]);
  });

  it("rejects a short JWT secret without revealing it", () => {
    const short = "x".repeat(MIN_JWT_SECRET_LENGTH - 1);
    const problems = problemsFor({ ...VALID, JWT_SECRET: short });
    assert.deepEqual(problems, [`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters, got ${MIN_JWT_SECRET_LENGTH - 1}`]);
    assert.ok(!problems.join().includes(short));
  });

  it("rejects malformed or wrong-protocol URLs without revealing credentials", () => {
    const problems = problemsFor({ ...VALID, DATABASE_URL: "mysql://root:hunter2@db/nimbus", REDIS_URL: "not a url" });
    assert.deepEqual(problems, ["DATABASE_URL must use postgresql:// or postgres://", "REDIS_URL is not a valid URL"]);
    assert.ok(!problems.join().includes("hunter2"));
  });

  for (const [name, value, expected] of [
    ["EXECUTION_RUN_TIMEOUT_MS", "-5", 'EXECUTION_RUN_TIMEOUT_MS must be a whole number, got "-5"'],
    ["EXECUTION_COMPILE_TIMEOUT_MS", "abc", 'EXECUTION_COMPILE_TIMEOUT_MS must be a whole number, got "abc"'],
    ["EXECUTION_RECONCILE_INTERVAL_MS", "0", "EXECUTION_RECONCILE_INTERVAL_MS must be between 5000 and 86400000, got 0"],
    ["EXECUTION_MAX_OUTPUT_BYTES", "1e6", 'EXECUTION_MAX_OUTPUT_BYTES must be a whole number, got "1e6"'],
    ["PORT", "70000", "PORT must be between 1 and 65535, got 70000"],
    ["NODE_ENV", "staging", 'NODE_ENV must be one of development, production, test, got "staging"'],
  ] as const) {
    it(`rejects ${name}=${value} instead of silently using a default`, () => {
      assert.deepEqual(problemsFor({ ...VALID, [name]: value }), [expected]);
    });
  }

  it("lists all problems in a single error message", () => {
    try {
      loadEnv({ ...VALID, JWT_SECRET: "short", EXECUTION_RUN_TIMEOUT_MS: "-1" });
      assert.fail("expected loadEnv to throw");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /^Invalid configuration:\n- JWT_SECRET must be at least 32 characters, got 5\n- EXECUTION_RUN_TIMEOUT_MS/);
    }
  });
});
