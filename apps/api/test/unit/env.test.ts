import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEVELOPMENT_CORS_ORIGIN, EXECUTION_DEFAULTS, MIN_JWT_SECRET_LENGTH, loadEnv } from "../../src/config/env.js";
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
      CORS_ORIGINS: ["http://localhost:5173"],
      EXECUTION_COMPILE_TIMEOUT_MS: 30000,
      EXECUTION_RUN_TIMEOUT_MS: 10000,
      EXECUTION_MAX_OUTPUT_BYTES: 64 * 1024,
      EXECUTION_ENQUEUE_TIMEOUT_MS: 5000,
      EXECUTION_RECONCILE_GRACE_MS: 300000,
      EXECUTION_RECONCILE_INTERVAL_MS: 60000,
      EXECUTION_MAX_ACTIVE_PER_USER: 3,
      EXECUTION_MAX_ACTIVE_TOTAL: 0,
      EXECUTION_RATE_LIMIT: 20,
      EXECUTION_RATE_WINDOW_MS: 60000,
      EXECUTION_HISTORY_MAX_PER_USER: 0,
      EXECUTION_HISTORY_MAX_TOTAL: 0,
      EXECUTION_RETENTION_INTERVAL_MS: 300000,
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
    const env = loadEnv({
      ...VALID,
      PORT: "8080",
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.example.com",
      EXECUTION_RUN_TIMEOUT_MS: "15000",
      REDIS_URL: "rediss://cache:6380",
    });
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

  describe("CORS_ORIGINS", () => {
    const PRODUCTION = { ...VALID, NODE_ENV: "production" };

    it("allows only the Vite dev server by default outside production", () => {
      assert.deepEqual(loadEnv(VALID).CORS_ORIGINS, [DEVELOPMENT_CORS_ORIGIN]);
      assert.deepEqual(loadEnv({ ...VALID, NODE_ENV: "test" }).CORS_ORIGINS, [DEVELOPMENT_CORS_ORIGIN]);
    });

    it("is required in production, so a forgotten setting fails at startup", () => {
      assert.deepEqual(problemsFor(PRODUCTION), ["CORS_ORIGINS is required"]);
      assert.deepEqual(problemsFor({ ...PRODUCTION, CORS_ORIGINS: "  " }), ["CORS_ORIGINS is required"]);
    });

    it("accepts https origins in production and normalizes case, trailing slashes and duplicates", () => {
      const env = loadEnv({ ...PRODUCTION, CORS_ORIGINS: "https://App.Example.com/, https://app.example.com,https://preview.example.com:8443" });
      assert.deepEqual(env.CORS_ORIGINS, ["https://app.example.com", "https://preview.example.com:8443"]);
    });

    it("normalizes default ports and internationalized hosts to the Origin header form browsers send", () => {
      const env = loadEnv({ ...PRODUCTION, CORS_ORIGINS: "https://app.example.com:443,https://bücher.example" });
      assert.deepEqual(env.CORS_ORIGINS, ["https://app.example.com", "https://xn--bcher-kva.example"]);
      assert.deepEqual(loadEnv({ ...VALID, CORS_ORIGINS: "http://localhost:80" }).CORS_ORIGINS, ["http://localhost"]);
    });

    it("keeps non-default ports and IPv4/IPv6 loopback origins distinct and exact outside production", () => {
      assert.deepEqual(loadEnv({ ...VALID, CORS_ORIGINS: "http://[::1]:5173, http://127.0.0.1:5173" }).CORS_ORIGINS, ["http://[::1]:5173", "http://127.0.0.1:5173"]);
    });

    it("accepts http origins outside production", () => {
      assert.deepEqual(loadEnv({ ...VALID, CORS_ORIGINS: "http://127.0.0.1:5173" }).CORS_ORIGINS, ["http://127.0.0.1:5173"]);
    });

    it("rejects http origins in production", () => {
      assert.deepEqual(problemsFor({ ...PRODUCTION, CORS_ORIGINS: "http://app.example.com" }), [
        'CORS_ORIGINS origins must use https://, got "http://app.example.com"',
      ]);
    });

    for (const [label, value, expected] of [
      ["a wildcard", "*", 'CORS_ORIGINS must not contain wildcards, got "*"'],
      ["a wildcard subdomain", "https://*.example.com", 'CORS_ORIGINS must not contain wildcards, got "https://*.example.com"'],
      ["the null origin", "null", 'CORS_ORIGINS must list origins such as https://app.example.com, got "null"'],
      ["a path", "https://app.example.com/app", 'CORS_ORIGINS must list bare origins without a path, query or credentials, got "https://app.example.com/app"'],
      ["a query", "https://app.example.com/?x=1", 'CORS_ORIGINS must list bare origins without a path, query or credentials, got "https://app.example.com/?x=1"'],
      ["an empty query", "https://app.example.com?", 'CORS_ORIGINS must list bare origins without a path, query or credentials, got "https://app.example.com?"'],
      ["a fragment", "https://app.example.com#top", 'CORS_ORIGINS must list bare origins without a path, query or credentials, got "https://app.example.com#top"'],
      ["a double slash path", "https://app.example.com//", 'CORS_ORIGINS must list bare origins without a path, query or credentials, got "https://app.example.com//"'],
      ["an invalid port", "https://app.example.com:99999", 'CORS_ORIGINS must list origins such as https://app.example.com, got "https://app.example.com:99999"'],
      ["http loopback", "http://127.0.0.1:5173", 'CORS_ORIGINS origins must use https://, got "http://127.0.0.1:5173"'],
      ["credentials", "https://user:pw@app.example.com", 'CORS_ORIGINS must list bare origins without a path, query or credentials, got "https://user:pw@app.example.com"'],
      ["a non-web scheme", "ftp://app.example.com", 'CORS_ORIGINS origins must use https://, got "ftp://app.example.com"'],
      ["an empty entry", "https://app.example.com,,https://b.example.com", "CORS_ORIGINS contains an empty origin"],
    ] as const) {
      it(`rejects ${label}`, () => {
        assert.deepEqual(problemsFor({ ...PRODUCTION, CORS_ORIGINS: value }), [expected]);
      });
    }

    it("rejects a wildcard outside production too", () => {
      assert.deepEqual(problemsFor({ ...VALID, CORS_ORIGINS: "*" }), ['CORS_ORIGINS must not contain wildcards, got "*"']);
    });
  });

  describe("execution resource defaults", () => {
    const PRODUCTION = { ...VALID, NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com" };

    it("keeps the original limits and unlimited history in development and test", () => {
      for (const nodeEnv of ["development", "test"]) {
        const env = loadEnv({ ...VALID, NODE_ENV: nodeEnv });
        assert.equal(env.EXECUTION_MAX_OUTPUT_BYTES, 64 * 1024);
        assert.equal(env.EXECUTION_RATE_LIMIT, 20);
        assert.equal(env.EXECUTION_MAX_ACTIVE_PER_USER, 3);
        assert.equal(env.EXECUTION_MAX_ACTIVE_TOTAL, 0, "no global cap outside production");
        assert.equal(env.EXECUTION_HISTORY_MAX_PER_USER, 0);
        assert.equal(env.EXECUTION_HISTORY_MAX_TOTAL, 0);
      }
    });

    it("applies conservative limits and bounded history in production", () => {
      const env = loadEnv(PRODUCTION);
      assert.deepEqual(
        {
          maxOutputBytes: env.EXECUTION_MAX_OUTPUT_BYTES,
          rateLimit: env.EXECUTION_RATE_LIMIT,
          maxActivePerUser: env.EXECUTION_MAX_ACTIVE_PER_USER,
          maxActiveTotal: env.EXECUTION_MAX_ACTIVE_TOTAL,
          historyMaxPerUser: env.EXECUTION_HISTORY_MAX_PER_USER,
          historyMaxTotal: env.EXECUTION_HISTORY_MAX_TOTAL,
        },
        EXECUTION_DEFAULTS.production,
      );
      assert.deepEqual(EXECUTION_DEFAULTS.production, {
        maxOutputBytes: 16384,
        rateLimit: 10,
        maxActivePerUser: 2,
        maxActiveTotal: 30,
        historyMaxPerUser: 50,
        historyMaxTotal: 1000,
      });
    });

    it("lets every production default be overridden, including disabling retention", () => {
      const env = loadEnv({
        ...PRODUCTION,
        EXECUTION_MAX_OUTPUT_BYTES: "8192",
        EXECUTION_RATE_LIMIT: "5",
        EXECUTION_MAX_ACTIVE_PER_USER: "1",
        EXECUTION_MAX_ACTIVE_TOTAL: "0",
        EXECUTION_HISTORY_MAX_PER_USER: "0",
        EXECUTION_HISTORY_MAX_TOTAL: "200",
        EXECUTION_RETENTION_INTERVAL_MS: "120000",
      });
      assert.equal(env.EXECUTION_MAX_OUTPUT_BYTES, 8192);
      assert.equal(env.EXECUTION_RATE_LIMIT, 5);
      assert.equal(env.EXECUTION_MAX_ACTIVE_PER_USER, 1);
      assert.equal(env.EXECUTION_MAX_ACTIVE_TOTAL, 0, "the global cap can be disabled explicitly");
      assert.equal(env.EXECUTION_HISTORY_MAX_PER_USER, 0);
      assert.equal(env.EXECUTION_HISTORY_MAX_TOTAL, 200);
      assert.equal(env.EXECUTION_RETENTION_INTERVAL_MS, 120000);
    });

    it("accepts a global active-execution cap within range", () => {
      assert.equal(loadEnv({ ...VALID, EXECUTION_MAX_ACTIVE_TOTAL: "100000" }).EXECUTION_MAX_ACTIVE_TOTAL, 100000);
      assert.equal(loadEnv({ ...PRODUCTION, EXECUTION_MAX_ACTIVE_TOTAL: "5" }).EXECUTION_MAX_ACTIVE_TOTAL, 5);
    });

    for (const [name, value, expected] of [
      ["EXECUTION_MAX_ACTIVE_TOTAL", "-1", 'EXECUTION_MAX_ACTIVE_TOTAL must be a whole number, got "-1"'],
      ["EXECUTION_MAX_ACTIVE_TOTAL", "100001", "EXECUTION_MAX_ACTIVE_TOTAL must be between 0 and 100000, got 100001"],
      ["EXECUTION_MAX_ACTIVE_TOTAL", "1.5", 'EXECUTION_MAX_ACTIVE_TOTAL must be a whole number, got "1.5"'],
      ["EXECUTION_HISTORY_MAX_PER_USER", "-1", 'EXECUTION_HISTORY_MAX_PER_USER must be a whole number, got "-1"'],
      ["EXECUTION_HISTORY_MAX_TOTAL", "ten", 'EXECUTION_HISTORY_MAX_TOTAL must be a whole number, got "ten"'],
      ["EXECUTION_RETENTION_INTERVAL_MS", "1000", "EXECUTION_RETENTION_INTERVAL_MS must be between 60000 and 86400000, got 1000"],
    ] as const) {
      it(`rejects ${name}=${value}`, () => {
        assert.deepEqual(problemsFor({ ...VALID, [name]: value }), [expected]);
      });
    }
  });

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
