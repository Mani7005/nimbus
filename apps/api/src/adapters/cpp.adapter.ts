import { randomUUID } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { env } from "../config/env.js";
import { runContainer, type ContainerRunResult, type RunContainerOptions } from "../runtime/docker.js";
import type { ExecutionResult } from "../runtime/execution-result.js";
import { getErrorMessage } from "../utils/errors.js";

export interface CppExecutionLimits {
  compileTimeoutMs: number;
  runTimeoutMs: number;
  maxOutputBytes: number;
}

export const DEFAULT_CPP_LIMITS: CppExecutionLimits = {
  compileTimeoutMs: env.EXECUTION_COMPILE_TIMEOUT_MS,
  runTimeoutMs: env.EXECUTION_RUN_TIMEOUT_MS,
  maxOutputBytes: env.EXECUTION_MAX_OUTPUT_BYTES,
};

export type ContainerRunner = (options: RunContainerOptions) => Promise<ContainerRunResult>;

export interface ExecuteCppOptions {
  runner?: ContainerRunner;
  limits?: CppExecutionLimits;
}

// Fixed commands: submitted code and stdin only reach the container as files in the mounted workspace.
export const COMPILE_COMMAND = ["g++", "main.cpp", "-o", "main"] as const;
export const RUN_COMMAND = ["bash", "-c", "./main < input.txt"] as const;

// `docker run` exits 125 when Docker itself fails after the container was created.
const DOCKER_RUN_FAILURE_EXIT_CODE = 125;
const DOCKER_ERROR_PATTERN = /^docker: |Error response from daemon/m;

const SIGNAL_DESCRIPTIONS: Record<number, string> = {
  6: "aborted (SIGABRT)",
  8: "floating point exception (SIGFPE)",
  9: "killed (SIGKILL); the program may have exceeded the memory limit",
  11: "segmentation fault (SIGSEGV)",
};

function seconds(ms: number): string {
  return `${ms / 1000}s`;
}

function result(fields: Partial<ExecutionResult> & Pick<ExecutionResult, "outcome">): ExecutionResult {
  return { stdout: "", stderr: "", compileOutput: "", exitCode: null, message: "", ...fields };
}

function infrastructureError(message: string): ExecutionResult {
  return result({ outcome: "INFRASTRUCTURE_ERROR", message });
}

/** Returns a reason when the failure came from Docker rather than from the submitted program. */
export function getInfrastructureFailure(run: ContainerRunResult): string | null {
  if (run.spawnError) return `Could not start Docker CLI: ${run.spawnError.message}`;
  if (!run.containerCreated) return `Docker did not create the container: ${run.stderr.trim() || `exit code ${run.exitCode}`}`;
  if (run.exitCode === null && !run.terminationReason) return `Docker CLI terminated by signal ${run.signal}`;
  if (run.exitCode === DOCKER_RUN_FAILURE_EXIT_CODE && DOCKER_ERROR_PATTERN.test(run.stderr)) return run.stderr.trim();
  return null;
}

export function describeExitCode(exitCode: number): string {
  const signal = exitCode > 128 ? SIGNAL_DESCRIPTIONS[exitCode - 128] : undefined;
  return `Process exited with code ${exitCode}${signal ? `: ${signal}` : ""}`;
}

/** Returns the final result when compilation did not succeed, or null to continue to the run phase. */
export function classifyCompile(compile: ContainerRunResult, limits: CppExecutionLimits): ExecutionResult | null {
  const infrastructureFailure = getInfrastructureFailure(compile);
  if (infrastructureFailure) return infrastructureError(infrastructureFailure);

  if (compile.terminationReason === "timeout") {
    return result({ outcome: "TIMEOUT", message: `Compilation Timed Out (limit ${seconds(limits.compileTimeoutMs)})` });
  }

  if (compile.exitCode !== 0) {
    return result({ outcome: "COMPILATION_ERROR", compileOutput: getCompileOutput(compile), exitCode: compile.exitCode });
  }

  return null;
}

export function getCompileOutput(compile: ContainerRunResult): string {
  const output = [compile.stderr.trim(), compile.stdout.trim()].filter(Boolean).join("\n");
  return compile.outputTruncated ? `${output}\n[compiler output truncated]` : output;
}

export function classifyRun(run: ContainerRunResult, compileOutput: string, limits: CppExecutionLimits): ExecutionResult {
  const infrastructureFailure = getInfrastructureFailure(run);
  if (infrastructureFailure) return infrastructureError(infrastructureFailure);

  const streams = { stdout: run.stdout.trim(), stderr: run.stderr.trim(), compileOutput, exitCode: run.exitCode };

  if (run.terminationReason === "timeout") {
    return result({ ...streams, outcome: "TIMEOUT", message: `Execution Timed Out (limit ${seconds(limits.runTimeoutMs)})` });
  }

  if (run.terminationReason === "output_limit") {
    return result({
      ...streams,
      outcome: "OUTPUT_LIMIT_EXCEEDED",
      message: `Output limit exceeded (${limits.maxOutputBytes} bytes); execution terminated`,
    });
  }

  if (run.exitCode === 0) return result({ ...streams, outcome: "SUCCESS" });

  return result({ ...streams, outcome: "RUNTIME_ERROR", message: describeExitCode(run.exitCode as number) });
}

export async function executeCpp(code: string, input: string, options: ExecuteCppOptions = {}): Promise<ExecutionResult> {
  const { runner = runContainer, limits = DEFAULT_CPP_LIMITS } = options;
  let tempDir: string | undefined;

  try {
    // Only workspaceDir is mounted; cid files stay outside so submitted code cannot tamper with them.
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbus-"));
    const workspaceDir = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "main.cpp"), code);
    await fs.writeFile(path.join(workspaceDir, "input.txt"), input);

    const executionId = randomUUID();
    const compile = await runner({
      containerName: `nimbus-compile-${executionId}`,
      cidFile: path.join(tempDir, "compile.cid"),
      workspaceDir,
      command: COMPILE_COMMAND,
      timeoutMs: limits.compileTimeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      terminateOnOutputLimit: false,
    });

    const compileFailure = classifyCompile(compile, limits);
    if (compileFailure) return compileFailure;

    const run = await runner({
      containerName: `nimbus-run-${executionId}`,
      cidFile: path.join(tempDir, "run.cid"),
      workspaceDir,
      command: RUN_COMMAND,
      timeoutMs: limits.runTimeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      terminateOnOutputLimit: true,
    });

    return classifyRun(run, getCompileOutput(compile), limits);
  } catch (error) {
    return infrastructureError(getErrorMessage(error));
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
