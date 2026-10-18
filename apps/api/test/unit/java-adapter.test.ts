// Mocked: the container runner is replaced, so no Docker daemon is used. See test/integration for real Docker tests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CPP_SANDBOXES } from "../../src/adapters/cpp.adapter.js";
import {
  DEFAULT_JAVA_SANDBOXES,
  JAVA_COMPILE_COMMAND,
  JAVA_IMAGE,
  JAVA_RUN_COMMAND,
  MISSING_MAIN_CLASS_OUTPUT,
  executeJava,
} from "../../src/adapters/java.adapter.js";
import type { ExecutionLimits } from "../../src/adapters/compiled-program.js";
import { sandboxConfig } from "../../src/config/sandbox.js";
import { buildDockerRunArgs, type ContainerRunResult, type RunContainerOptions } from "../../src/runtime/docker.js";
import { formatExecutionOutput, toExecutionStatus } from "../../src/runtime/execution-result.js";
import { runResult } from "./fakes.js";

const LIMITS: ExecutionLimits = { compileTimeoutMs: 30000, runTimeoutMs: 10000, maxOutputBytes: 1024 };

/**
 * Returns the scripted results in order. A successful compile stage writes Main.class, as javac would, unless
 * `writeMainClass` is false.
 */
function scriptedRunner(results: ContainerRunResult[], { writeMainClass = true } = {}) {
  const calls: RunContainerOptions[] = [];
  const runner = async (options: RunContainerOptions) => {
    calls.push(options);
    const next = results.shift();
    if (!next) throw new Error("unexpected container run");
    if (options.command === JAVA_COMPILE_COMMAND && next.exitCode === 0 && writeMainClass) {
      await fs.writeFile(path.join(options.workspaceDir, "Main.class"), "");
    }
    return next;
  };
  return { runner, calls };
}

describe("executeJava", () => {
  it("compiles then runs Main.java in separate named containers, passing code and input only as files", async () => {
    const code = 'public class Main { public static void main(String[] a) throws Exception { Runtime.getRuntime().exec("rm -rf /"); } } // "; $(whoami) `id`';
    const input = "1 2\n$(reboot)";
    const seenFiles: string[] = [];
    const { runner, calls } = scriptedRunner([runResult(), runResult({ stdout: "ok\n" })]);
    const recordingRunner = async (options: RunContainerOptions) => {
      seenFiles.push(await fs.readFile(path.join(options.workspaceDir, "Main.java"), "utf8"));
      seenFiles.push(await fs.readFile(path.join(options.workspaceDir, "input.txt"), "utf8"));
      return runner(options);
    };

    const result = await executeJava(code, input, { runner: recordingRunner, limits: LIMITS });

    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.stdout, "ok");
    assert.deepEqual(seenFiles, [code, input, code, input]);
    assert.deepEqual(calls.map((call) => call.command), [JAVA_COMPILE_COMMAND, JAVA_RUN_COMMAND]);
    assert.deepEqual(calls.map((call) => call.terminateOnOutputLimit), [false, true]);
    assert.deepEqual(calls.map((call) => call.timeoutMs), [LIMITS.compileTimeoutMs, LIMITS.runTimeoutMs]);
    assert.deepEqual(calls.map((call) => call.readOnlyWorkspace ?? false), [false, true], "only javac may write to the workspace");
    assert.match(calls[0].containerName, /^nimbus-compile-[0-9a-f-]{36}$/);
    assert.match(calls[1].containerName, /^nimbus-run-[0-9a-f-]{36}$/);

    for (const call of calls) {
      const args = buildDockerRunArgs(call);
      assert.ok(!args.some((arg) => arg.includes("whoami") || arg.includes("reboot")), "submitted text must not appear in docker arguments");
      assert.ok(path.relative(call.workspaceDir, call.cidFile).startsWith(".."), "cid file must live outside the mounted workspace");
      assert.equal(args[args.indexOf("timeout") - 1], JAVA_IMAGE, "runs the pinned Java image");
    }
  });

  it("uses fixed javac and java commands with the verified JVM flags", () => {
    assert.deepEqual(JAVA_COMPILE_COMMAND, ["javac", "-J-XX:+UseSerialGC", "-J-XX:-UsePerfData", "-encoding", "UTF-8", "Main.java"]);
    assert.deepEqual(JAVA_RUN_COMMAND, ["bash", "-c", "java -XX:+UseSerialGC -XX:-UsePerfData -XX:MaxRAMPercentage=50 -cp . Main < input.txt"]);
  });

  it("pins the Java image by digest", () => {
    assert.match(JAVA_IMAGE, /^eclipse-temurin:21-jdk-noble@sha256:[0-9a-f]{64}$/);
  });

  it("uses the C++ sandbox limits with only the image changed, never as root", () => {
    for (const stage of ["compile", "run"] as const) {
      assert.deepEqual(DEFAULT_JAVA_SANDBOXES[stage], { ...DEFAULT_CPP_SANDBOXES[stage], image: JAVA_IMAGE });
      assert.equal(DEFAULT_JAVA_SANDBOXES[stage].user, "65534:65534");
    }
    assert.equal(DEFAULT_JAVA_SANDBOXES.compile.memoryMb, sandboxConfig.compileMemoryMb);
    assert.equal(DEFAULT_JAVA_SANDBOXES.run.memoryMb, sandboxConfig.runMemoryMb);
  });

  it("makes the workspace usable by the unprivileged container user", { skip: process.platform === "win32" && "POSIX modes only" }, async () => {
    const modes: number[] = [];
    await executeJava("", "", {
      limits: LIMITS,
      runner: async (options) => {
        modes.push((await fs.stat(options.workspaceDir)).mode & 0o777);
        modes.push((await fs.stat(path.join(options.workspaceDir, "Main.java"))).mode & 0o777);
        modes.push((await fs.stat(path.dirname(options.workspaceDir))).mode & 0o777);
        return runResult({ exitCode: 1 });
      },
    });
    assert.deepEqual(modes, [0o777, 0o644, 0o700]);
  });

  it("removes the temporary directory afterwards", async () => {
    let workspaceDir = "";
    const { runner } = scriptedRunner([runResult(), runResult()]);
    await executeJava("", "", {
      limits: LIMITS,
      runner: async (options) => {
        workspaceDir = options.workspaceDir;
        return runner(options);
      },
    });
    await assert.rejects(fs.access(path.dirname(workspaceDir)));
  });

  it("reports a javac error without running the program", async () => {
    const stderr = "Main.java:1: error: ';' expected\npublic class Main { int x }\n                         ^\n1 error\n";
    const { runner, calls } = scriptedRunner([runResult({ exitCode: 1, stderr })]);
    const result = await executeJava("public class Main { int x }", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.equal(result.exitCode, 1);
    assert.equal(result.compileOutput, stderr.trim());
    assert.equal(formatExecutionOutput(result), stderr.trim());
    assert.equal(calls.length, 1);
    assert.equal(toExecutionStatus(result.outcome), "FAILED");
  });

  it("reports a missing Main class as a compilation error without running the program", async () => {
    const { runner, calls } = scriptedRunner([runResult()], { writeMainClass: false });
    const result = await executeJava("class Solution { public static void main(String[] a) {} }", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.equal(formatExecutionOutput(result), MISSING_MAIN_CLASS_OUTPUT);
    assert.equal(calls.length, 1);
  });

  it("keeps javac warnings alongside the missing Main class message", async () => {
    const { runner } = scriptedRunner([runResult({ stderr: "Note: Solution.java uses unchecked or unsafe operations.\n" })], { writeMainClass: false });
    const result = await executeJava("", "", { runner, limits: LIMITS });
    assert.equal(result.compileOutput, `Note: Solution.java uses unchecked or unsafe operations.\n${MISSING_MAIN_CLASS_OUTPUT}`);
  });

  it("does not accept a directory named Main.class as the compiled program", async () => {
    const { runner, calls } = scriptedRunner([runResult()], { writeMainClass: false });
    const result = await executeJava("", "", {
      limits: LIMITS,
      runner: async (options) => {
        await fs.mkdir(path.join(options.workspaceDir, "Main.class"));
        return runner(options);
      },
    });
    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.equal(calls.length, 1);
  });

  it("keeps javac warnings separate from a successful run", async () => {
    const { runner } = scriptedRunner([
      runResult({ stderr: "Note: Main.java uses or overrides a deprecated API.\n" }),
      runResult({ stdout: "Hello Nimbus" }),
    ]);
    const result = await executeJava("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.compileOutput, "Note: Main.java uses or overrides a deprecated API.");
    assert.equal(formatExecutionOutput(result), "Hello Nimbus\n\n[compiler warnings]\nNote: Main.java uses or overrides a deprecated API.");
  });

  it("reports System.exit codes as runtime errors", async () => {
    const { runner } = scriptedRunner([runResult(), runResult({ exitCode: 3, stdout: "partial" })]);
    const result = await executeJava("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "RUNTIME_ERROR");
    assert.equal(result.exitCode, 3);
    assert.equal(result.message, "Process exited with code 3");
    assert.equal(toExecutionStatus(result.outcome), "FAILED");
  });

  it("reports an uncaught exception with its stack trace", async () => {
    const stderr = 'Exception in thread "main" java.lang.IllegalStateException: boom\n\tat Main.main(Main.java:3)\n';
    const { runner } = scriptedRunner([runResult(), runResult({ exitCode: 1, stderr })]);
    const result = await executeJava("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "RUNTIME_ERROR");
    assert.equal(result.exitCode, 1);
    assert.equal(formatExecutionOutput(result), `[stderr]\n${stderr.trim()}\n\nProcess exited with code 1`);
  });

  it("reports a run timeout", async () => {
    const { runner } = scriptedRunner([runResult(), runResult({ exitCode: 137, terminationReason: "timeout", stdout: "tick" })]);
    const result = await executeJava("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.message, "Execution Timed Out (limit 10s)");
    assert.equal(toExecutionStatus(result.outcome), "TIMEOUT");
  });

  it("reports a compile timeout without running the program", async () => {
    const { runner, calls } = scriptedRunner([runResult({ exitCode: 137, terminationReason: "timeout" })]);
    const result = await executeJava("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.message, "Compilation Timed Out (limit 30s)");
    assert.equal(calls.length, 1);
  });

  it("reports an output limit violation", async () => {
    const { runner } = scriptedRunner([
      runResult(),
      runResult({ exitCode: 137, terminationReason: "output_limit", outputTruncated: true, stdout: "y".repeat(1024) }),
    ]);
    const result = await executeJava("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "OUTPUT_LIMIT_EXCEEDED");
    assert.equal(result.message, "Output limit exceeded (1024 bytes); execution terminated");
  });

  it("classifies a missing image as infrastructure, not a compilation error", async () => {
    const { runner } = scriptedRunner([
      runResult({ exitCode: 125, containerCreated: false, stderr: `docker: Error response from daemon: No such image: ${JAVA_IMAGE}` }),
    ]);
    const result = await executeJava("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "INFRASTRUCTURE_ERROR");
    assert.match(result.message, /No such image/);
    assert.doesNotMatch(formatExecutionOutput(result), /docker|image/i, "infrastructure details are logged, not shown to users");
  });

  it("classifies a Docker failure in the run stage as infrastructure", async () => {
    const { runner } = scriptedRunner([
      runResult(),
      runResult({ exitCode: 125, stderr: "docker: Error response from daemon: failed to create task for container" }),
    ]);
    const result = await executeJava("", "", { runner, limits: LIMITS });
    assert.equal(result.outcome, "INFRASTRUCTURE_ERROR");
  });

  it("returns an infrastructure error instead of throwing when the runner throws", async () => {
    const result = await executeJava("", "", {
      limits: LIMITS,
      runner: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(result.outcome, "INFRASTRUCTURE_ERROR");
    assert.equal(result.message, "boom");
  });
});
