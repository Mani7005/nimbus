// Mocked: the execution store, executor and logger are in-memory fakes; no Postgres, Redis or Docker is used.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Backoffs, UnrecoverableError } from "bullmq";
import { EXECUTION_JOB_OPTIONS } from "../../src/queues/execution.job.js";
import { INFRASTRUCTURE_ERROR_OUTPUT, type ExecutionResult } from "../../src/runtime/execution-result.js";
import {
  UNSUPPORTED_LANGUAGE_OUTPUT,
  handleFailedExecutionJob,
  isFinalAttempt,
  findExecutor,
  processExecutionJob,
  type ExecutionJobDeps,
  type Executor,
  type ExecutionStore,
} from "../../src/workers/execution.processor.js";

interface Row {
  id: string;
  language: string;
  code: string;
  input: string | null;
  status: string;
  output: string | null;
}

const ID = "cmrm5whp00000ieqonyoqlbge";
let rows: Row[];
let logs: { level: string; message: string }[];
let executed: { language: string; code: string; input: string; row: Row | undefined }[];
let nextResult: ExecutionResult;

const store: ExecutionStore = {
  findUnique: async ({ where }) => rows.find((row) => row.id === where.id) ?? null,
  updateMany: async ({ where, data }) => {
    const matched = rows.filter((row) => row.id === where.id && where.status.in.includes(row.status));
    for (const row of matched) Object.assign(row, data);
    return { count: matched.length };
  },
};

function recordingExecutor(language: string): Executor {
  return async (code, input) => {
    executed.push({ language, code, input, row: rows[0] && { ...rows[0] } });
    return nextResult;
  };
}

function deps(overrides: Partial<ExecutionJobDeps> = {}): ExecutionJobDeps {
  return {
    executions: store,
    executors: { cpp: recordingExecutor("cpp"), java: recordingExecutor("java") },
    logger: {
      log: (message: string) => logs.push({ level: "log", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
    },
    ...overrides,
  };
}

function result(fields: Partial<ExecutionResult> & Pick<ExecutionResult, "outcome">): ExecutionResult {
  return { stdout: "", stderr: "", compileOutput: "", exitCode: 0, message: "", ...fields };
}

function job(attemptsMade = 0, executionId = ID) {
  return { id: "job-1", data: { executionId }, attemptsMade, opts: { ...EXECUTION_JOB_OPTIONS } };
}

function row(): Row {
  return rows[0];
}

beforeEach(() => {
  rows = [{ id: ID, language: "cpp", code: "int main() {}", input: "1 2", status: "PENDING", output: null }];
  logs = [];
  executed = [];
  nextResult = result({ outcome: "SUCCESS", stdout: "Hello Nimbus" });
});

describe("retry policy", () => {
  it("retries up to 3 attempts with exponential backoff of 2s then 4s", () => {
    assert.equal(EXECUTION_JOB_OPTIONS.attempts, 3);
    assert.deepEqual(EXECUTION_JOB_OPTIONS.removeOnComplete, { age: 86_400, count: 1000 }, "completed jobs: 1 day, at most 1000");
    assert.deepEqual(EXECUTION_JOB_OPTIONS.removeOnFail, { age: 604_800, count: 5000 }, "failed jobs: 7 days, at most 5000");
    const backoff = Backoffs.normalize(EXECUTION_JOB_OPTIONS.backoff);
    assert.ok(backoff);
    const delays = [1, 2].map((attempt) => Backoffs.calculate(backoff, attempt, new Error("x"), {} as never));
    assert.deepEqual(delays, [2000, 4000]);
  });
});

describe("processExecutionJob", () => {
  it("runs the program and persists a successful result", async () => {
    await processExecutionJob(job(), deps());
    assert.deepEqual(executed.map(({ code, input }) => ({ code, input })), [{ code: "int main() {}", input: "1 2" }]);
    assert.equal(row().status, "COMPLETED");
    assert.equal(row().output, "Hello Nimbus");
  });

  for (const [outcome, status] of [
    ["COMPILATION_ERROR", "FAILED"],
    ["RUNTIME_ERROR", "FAILED"],
    ["TIMEOUT", "TIMEOUT"],
    ["OUTPUT_LIMIT_EXCEEDED", "FAILED"],
  ] as const) {
    it(`persists a ${outcome} result without throwing, so the job is not retried`, async () => {
      nextResult = result({ outcome, compileOutput: "error: x", message: "detail" });
      await processExecutionJob(job(), deps());
      assert.equal(row().status, status);
    });
  }

  for (const language of ["cpp", "java"]) {
    it(`dispatches ${language} executions to the ${language} executor only`, async () => {
      row().language = language;
      await processExecutionJob(job(), deps());
      assert.deepEqual(executed.map((run) => run.language), [language]);
      assert.equal(row().status, "COMPLETED");
      assert.equal(row().output, "Hello Nimbus");
    });
  }

  it("persists a Java compilation error in the standard output format", async () => {
    row().language = "java";
    nextResult = result({ outcome: "COMPILATION_ERROR", exitCode: 1, compileOutput: "Main.java:1: error: ';' expected" });
    await processExecutionJob(job(), deps());
    assert.equal(row().status, "FAILED");
    assert.equal(row().output, "Main.java:1: error: ';' expected");
  });

  for (const language of ["brainfuck", "python", "Java", "", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    it(`marks unsupported language ${JSON.stringify(language)} FAILED without throwing or executing`, async () => {
      row().language = language;
      await processExecutionJob(job(), deps());
      assert.equal(row().status, "FAILED");
      assert.equal(row().output, UNSUPPORTED_LANGUAGE_OUTPUT);
      assert.equal(executed.length, 0);
    });
  }

  it("throws on infrastructure errors so BullMQ retries, leaving the execution unfinished", async () => {
    nextResult = result({ outcome: "INFRASTRUCTURE_ERROR", message: "docker daemon down" });
    await assert.rejects(processExecutionJob(job(), deps()), /Infrastructure error: docker daemon down/);
    assert.equal(row().status, "RUNNING");
    assert.equal(row().output, null);
  });

  it("propagates persistence errors so BullMQ retries", async () => {
    const failing: ExecutionStore = { ...store, updateMany: async () => Promise.reject(new Error("db down")) };
    await assert.rejects(processExecutionJob(job(), deps({ executions: failing })), /db down/);
  });

  it("clears stale status and output when a retry starts", async () => {
    Object.assign(row(), { status: "PENDING", output: "partial output from attempt 1" });
    await processExecutionJob(job(1), deps());
    assert.equal(executed[0].row?.status, "RUNNING");
    assert.equal(executed[0].row?.output, null);
    assert.equal(row().output, "Hello Nimbus");
  });

  it("also restarts an execution left RUNNING by an attempt that crashed", async () => {
    Object.assign(row(), { status: "RUNNING", output: "stale" });
    await processExecutionJob(job(1), deps());
    assert.equal(row().status, "COMPLETED");
  });

  it("does not re-run an execution that already finished", async () => {
    Object.assign(row(), { status: "COMPLETED", output: "done" });
    await processExecutionJob(job(1), deps());
    assert.equal(executed.length, 0);
    assert.equal(row().output, "done");
  });

  it("completes without error when the execution record is missing", async () => {
    rows = [];
    await processExecutionJob(job(), deps());
    assert.equal(executed.length, 0);
    assert.ok(logs.some((log) => log.level === "warn" && /missing/.test(log.message)));
  });

  it("does not throw when the execution is deleted while running", async () => {
    const vanishing = deps({
      executors: {
        cpp: async () => {
          rows = [];
          return nextResult;
        },
        java: recordingExecutor("java"),
      },
    });
    await processExecutionJob(job(), vanishing);
    assert.ok(logs.some((log) => /removed before its result could be saved/.test(log.message)));
  });
});

describe("findExecutor", () => {
  const executors = deps().executors;

  it("returns the executor registered for each supported language", () => {
    assert.equal(findExecutor(executors, "cpp"), executors.cpp);
    assert.equal(findExecutor(executors, "java"), executors.java);
  });

  it("never resolves inherited Object properties", () => {
    for (const language of ["constructor", "__proto__", "toString", "hasOwnProperty", "isPrototypeOf", "__defineGetter__"]) {
      assert.equal(findExecutor(executors, language), undefined, language);
    }
  });
});

describe("isFinalAttempt", () => {
  it("is false while retries remain and true once they are exhausted", () => {
    const error = new Error("x");
    assert.equal(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } }, error), false);
    assert.equal(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } }, error), false);
    assert.equal(isFinalAttempt({ attemptsMade: 3, opts: { attempts: 3 } }, error), true);
  });

  it("treats a job without an attempts option as single-attempt", () => {
    assert.equal(isFinalAttempt({ attemptsMade: 1, opts: {} }, new Error("x")), true);
  });

  it("treats UnrecoverableError as final regardless of remaining attempts", () => {
    assert.equal(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } }, new UnrecoverableError("stop")), true);
  });
});

describe("handleFailedExecutionJob", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { stack: "Error: at secret/internal/path.ts:1" });

  it("does not mark the execution FAILED before retries are exhausted", async () => {
    Object.assign(row(), { status: "RUNNING", output: "partial" });
    for (const attemptsMade of [1, 2]) {
      await handleFailedExecutionJob(job(attemptsMade), error, deps());
      assert.equal(row().status, "PENDING");
      assert.equal(row().output, null);
    }
  });

  it("marks the execution FAILED with a safe message after the final attempt", async () => {
    row().status = "RUNNING";
    await handleFailedExecutionJob(job(3), error, deps());
    assert.equal(row().status, "FAILED");
    assert.equal(row().output, INFRASTRUCTURE_ERROR_OUTPUT);
    assert.doesNotMatch(row().output ?? "", /ECONNREFUSED|10\.0\.0\.5|secret|stack|at /);
  });

  it("never overwrites a finished result", async () => {
    Object.assign(row(), { status: "COMPLETED", output: "done" });
    await handleFailedExecutionJob(job(3), error, deps());
    assert.equal(row().status, "COMPLETED");
    assert.equal(row().output, "done");
  });

  it("handles a missing execution record without throwing", async () => {
    rows = [];
    await handleFailedExecutionJob(job(3), error, deps());
    assert.ok(logs.some((log) => log.level === "warn" && /not marked FAILED/.test(log.message)));
  });

  it("logs and swallows errors while persisting the failure", async () => {
    const failing: ExecutionStore = { ...store, updateMany: async () => Promise.reject(new Error("db down")) };
    await handleFailedExecutionJob(job(3), error, deps({ executions: failing }));
    await handleFailedExecutionJob(job(1), error, deps({ executions: failing }));
    const persistLogs = logs.filter((log) => /Could not record failure/.test(log.message));
    assert.equal(persistLogs.length, 2);
    assert.ok(persistLogs.every((log) => log.level === "error" && log.message.includes("db down")));
  });

  it("logs and swallows synchronous throws from the store", async () => {
    const throwing: ExecutionStore = {
      ...store,
      updateMany: () => {
        throw new Error("sync boom");
      },
    };
    await handleFailedExecutionJob(job(3), error, deps({ executions: throwing }));
    assert.ok(logs.some((log) => /sync boom/.test(log.message)));
  });

  it("handles an undefined job or missing execution id", async () => {
    await handleFailedExecutionJob(undefined, error, deps());
    await handleFailedExecutionJob({ id: "j", data: {} as never, attemptsMade: 3, opts: {} }, error, deps());
    assert.equal(logs.filter((log) => /without an execution id/.test(log.message)).length, 2);
    assert.equal(row().status, "PENDING");
  });
});
