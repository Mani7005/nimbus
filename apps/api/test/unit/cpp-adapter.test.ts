// Mocked: the container runner is replaced, so no Docker daemon is used. See test/integration for real Docker tests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  COMPILE_COMMAND,
  DEFAULT_CPP_SANDBOXES,
  RUN_COMMAND,
  describeExitCode,
  executeCpp,
  type CppExecutionLimits,
  type CppSandboxes,
} from "../../src/adapters/cpp.adapter.js";
import { sandboxConfig } from "../../src/config/sandbox.js";
import { DEFAULT_SANDBOX, buildDockerRunArgs, type ContainerRunResult, type RunContainerOptions } from "../../src/runtime/docker.js";
import { formatExecutionOutput, toExecutionStatus } from "../../src/runtime/execution-result.js";
import { runResult } from "./fakes.js";

const LIMITS: CppExecutionLimits = { compileTimeoutMs: 30000, runTimeoutMs: 10000, maxOutputBytes: 1024 };

function scriptedRunner(...results: ContainerRunResult[]) {
  const calls: RunContainerOptions[] = [];
  const runner = async (options: RunContainerOptions) => {
    calls.push(options);
    const next = results.shift();
    if (!next) throw new Error("unexpected container run");
    return next;
  };
  return { runner, calls };
}

describe("executeCpp", () => {
  it("compiles then runs in separate named containers, passing code and input only as files", async () => {
    const code = 'int main() { system("rm -rf /"); } // "; $(whoami) `id` & del C:\\';
    const input = "1 2\n$(reboot)";
    const seenFiles: string[] = [];
    const { runner, calls } = scriptedRunner(runResult(), runResult({ stdout: "ok\n" }));
    const recordingRunner = async (options: RunContainerOptions) => {
      seenFiles.push(await fs.readFile(path.join(options.workspaceDir, "main.cpp"), "utf8"));
      seenFiles.push(await fs.readFile(path.join(options.workspaceDir, "input.txt"), "utf8"));
      return runner(options);
    };

    const result = await executeCpp(code, input, { runner: recordingRunner, limits: LIMITS });

    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.stdout, "ok");
    assert.deepEqual(seenFiles, [code, input, code, input]);
    assert.deepEqual(calls.map((call) => call.command), [COMPILE_COMMAND, RUN_COMMAND]);
    assert.deepEqual(calls.map((call) => call.terminateOnOutputLimit), [false, true]);
    assert.deepEqual(calls.map((call) => call.timeoutMs), [LIMITS.compileTimeoutMs, LIMITS.runTimeoutMs]);
    assert.deepEqual(calls.map((call) => call.readOnlyWorkspace ?? false), [false, true], "only g++ may write to the workspace");
    assert.notEqual(calls[0].containerName, calls[1].containerName);
    assert.match(calls[0].containerName, /^nimbus-compile-[0-9a-f-]{36}$/);
    assert.match(calls[1].containerName, /^nimbus-run-[0-9a-f-]{36}$/);

    for (const call of calls) {
      const args = buildDockerRunArgs(call);
      assert.ok(!args.some((arg) => arg.includes("whoami") || arg.includes("reboot")), "submitted text must not appear in docker arguments");
      assert.ok(path.relative(call.workspaceDir, call.cidFile).startsWith(".."), "cid file must live outside the mounted workspace");
    }
  });

  it("uses the compile and run sandboxes for their stages", async () => {
    const sandboxes: CppSandboxes = {
      compile: { ...DEFAULT_SANDBOX, memoryMb: 512 },
      run: { ...DEFAULT_SANDBOX, memoryMb: 64 },
    };
    const { runner, calls } = scriptedRunner(runResult(), runResult());
    await executeCpp("", "", { runner, limits: LIMITS, sandboxes });
    assert.deepEqual(calls.map((call) => call.sandbox?.memoryMb), [512, 64]);
  });

  it("configures default sandboxes from validated settings, never as root", () => {
    for (const sandbox of [DEFAULT_CPP_SANDBOXES.compile, DEFAULT_CPP_SANDBOXES.run]) {
      assert.equal(sandbox.user, "65534:65534");
      assert.equal(sandbox.pidsLimit, sandboxConfig.pidsLimit);
      assert.equal(sandbox.maxFileSizeBytes, sandboxConfig.maxFileSizeBytes);
    }
    assert.equal(DEFAULT_CPP_SANDBOXES.compile.memoryMb, sandboxConfig.compileMemoryMb);
    assert.equal(DEFAULT_CPP_SANDBOXES.run.memoryMb, sandboxConfig.runMemoryMb);
  });

  it("makes the workspace usable by the unprivileged container user", { skip: process.platform === "win32" && "POSIX modes only" }, async () => {
    const modes: number[] = [];
    await executeCpp("", "", {
      limits: LIMITS,
      runner: async (options) => {
        modes.push((await fs.stat(options.workspaceDir)).mode & 0o777);
        modes.push((await fs.stat(path.join(options.workspaceDir, "main.cpp"))).mode & 0o777);
        modes.push((await fs.stat(path.dirname(options.workspaceDir))).mode & 0o777);
        return runResult({ exitCode: 1 });
      },
    });
    assert.deepEqual(modes, [0o777, 0o644, 0o700]);
  });

  it("removes the temporary directory afterwards", async () => {
    let workspaceDir = "";
    await executeCpp("", "", {
      limits: LIMITS,
      runner: async (options) => {
        workspaceDir = options.workspaceDir;
        return runResult({ exitCode: 1, stderr: "error" });
      },
    });
    await assert.rejects(fs.access(path.dirname(workspaceDir)));
  });

  it("reports a compilation error without running the program", async () => {
    const { runner, calls } = scriptedRunner(runResult({ exitCode: 1, stderr: "main.cpp:1:1: error: expected ';'\n" }));
    const result = await executeCpp("int x", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.equal(result.compileOutput, "main.cpp:1:1: error: expected ';'");
    assert.equal(calls.length, 1);
    assert.equal(toExecutionStatus(result.outcome), "FAILED");
  });

  it("keeps compiler warnings separate from a successful run", async () => {
    const { runner } = scriptedRunner(
      runResult({ stderr: "main.cpp:3:7: warning: unused variable 'x'\n" }),
      runResult({ stdout: "Hello Nimbus" }),
    );
    const result = await executeCpp("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.stdout, "Hello Nimbus");
    assert.equal(result.compileOutput, "main.cpp:3:7: warning: unused variable 'x'");
    assert.equal(toExecutionStatus(result.outcome), "COMPLETED");
  });

  it("treats stderr from a program that exits 0 as success", async () => {
    const { runner } = scriptedRunner(runResult(), runResult({ stdout: "42", stderr: "debug: n=6" }));
    const result = await executeCpp("", "", { runner, limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.stderr, "debug: n=6");
  });

  it("reports a runtime error with the real exit code even when stderr is empty", async () => {
    const { runner } = scriptedRunner(runResult(), runResult({ exitCode: 3, stdout: "partial" }));
    const result = await executeCpp("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "RUNTIME_ERROR");
    assert.equal(result.exitCode, 3);
    assert.equal(result.message, "Process exited with code 3");
    assert.equal(toExecutionStatus(result.outcome), "FAILED");
  });

  it("reports a run timeout", async () => {
    const { runner } = scriptedRunner(runResult(), runResult({ exitCode: 137, terminationReason: "timeout", stdout: "tick" }));
    const result = await executeCpp("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.message, "Execution Timed Out (limit 10s)");
    assert.equal(result.stdout, "tick");
    assert.equal(toExecutionStatus(result.outcome), "TIMEOUT");
  });

  it("reports a compile timeout without running the program", async () => {
    const { runner, calls } = scriptedRunner(runResult({ exitCode: 137, terminationReason: "timeout" }));
    const result = await executeCpp("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.message, "Compilation Timed Out (limit 30s)");
    assert.equal(calls.length, 1);
  });

  it("reports an output limit violation", async () => {
    const { runner } = scriptedRunner(
      runResult(),
      runResult({ exitCode: 137, terminationReason: "output_limit", outputTruncated: true, stdout: "y".repeat(1024) }),
    );
    const result = await executeCpp("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "OUTPUT_LIMIT_EXCEEDED");
    assert.equal(result.message, "Output limit exceeded (1024 bytes); execution terminated");
    assert.equal(toExecutionStatus(result.outcome), "FAILED");
  });

  it("classifies an unreachable Docker daemon as infrastructure, not a compilation error", async () => {
    const { runner } = scriptedRunner(
      runResult({ exitCode: 1, containerCreated: false, stderr: "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine" }),
    );
    const result = await executeCpp("", "", { runner, limits: LIMITS });

    assert.equal(result.outcome, "INFRASTRUCTURE_ERROR");
    assert.match(result.message, /failed to connect to the docker API/);
    assert.equal(toExecutionStatus(result.outcome), "FAILED");
    assert.doesNotMatch(formatExecutionOutput(result), /docker/i, "infrastructure details are logged, not shown to users");
  });

  it("classifies a missing docker executable as infrastructure", async () => {
    const { runner } = scriptedRunner(runResult({ exitCode: null, containerCreated: false, spawnError: new Error("spawn docker ENOENT") }));
    const result = await executeCpp("", "", { runner, limits: LIMITS });
    assert.equal(result.outcome, "INFRASTRUCTURE_ERROR");
    assert.match(result.message, /ENOENT/);
  });

  it("classifies a Docker start failure after container creation as infrastructure", async () => {
    const { runner } = scriptedRunner(
      runResult(),
      runResult({ exitCode: 125, stderr: "docker: Error response from daemon: failed to create task for container" }),
    );
    const result = await executeCpp("", "", { runner, limits: LIMITS });
    assert.equal(result.outcome, "INFRASTRUCTURE_ERROR");
  });

  it("treats exit code 125 from the program itself as a runtime error", async () => {
    const { runner } = scriptedRunner(runResult(), runResult({ exitCode: 125 }));
    const result = await executeCpp("", "", { runner, limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR");
  });

  it("returns an infrastructure error instead of throwing when the runner throws", async () => {
    const result = await executeCpp("", "", {
      limits: LIMITS,
      runner: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(result.outcome, "INFRASTRUCTURE_ERROR");
    assert.equal(result.message, "boom");
  });
});

describe("describeExitCode", () => {
  it("names common fatal signals", () => {
    assert.equal(describeExitCode(1), "Process exited with code 1");
    assert.equal(describeExitCode(139), "Process exited with code 139: segmentation fault (SIGSEGV)");
    assert.match(describeExitCode(137), /SIGKILL.*memory limit/);
    assert.equal(describeExitCode(153), "Process exited with code 153: file size limit exceeded (SIGXFSZ)");
  });
});
