import { sandboxConfig } from "../config/sandbox.js";
import type { ExecutionResult } from "../runtime/execution-result.js";
import {
  DEFAULT_EXECUTION_LIMITS,
  configuredSandbox,
  executeCompiledProgram,
  type CompiledLanguage,
  type ContainerRunner,
  type ExecutionLimits,
  type StageSandboxes,
} from "./compiled-program.js";

export {
  classifyCompile,
  classifyRun,
  describeExitCode,
  getCompileOutput,
  getInfrastructureFailure,
  type ContainerRunner,
} from "./compiled-program.js";

export type CppExecutionLimits = ExecutionLimits;

export const DEFAULT_CPP_LIMITS: CppExecutionLimits = DEFAULT_EXECUTION_LIMITS;

export type CppSandboxes = StageSandboxes;

// g++ needs more memory than most programs; swap is disabled, so the limits are exact.
export const DEFAULT_CPP_SANDBOXES: CppSandboxes = {
  compile: configuredSandbox(sandboxConfig.compileMemoryMb),
  run: configuredSandbox(sandboxConfig.runMemoryMb),
};

export interface ExecuteCppOptions {
  runner?: ContainerRunner;
  limits?: CppExecutionLimits;
  sandboxes?: CppSandboxes;
}

// Fixed commands: submitted code and stdin only reach the container as files in the mounted workspace.
export const COMPILE_COMMAND = ["g++", "main.cpp", "-o", "main"] as const;
export const RUN_COMMAND = ["bash", "-c", "./main < input.txt"] as const;

const CPP: CompiledLanguage = { sourceFile: "main.cpp", compileCommand: COMPILE_COMMAND, runCommand: RUN_COMMAND };

export function executeCpp(code: string, input: string, options: ExecuteCppOptions = {}): Promise<ExecutionResult> {
  const { sandboxes = DEFAULT_CPP_SANDBOXES, ...rest } = options;
  return executeCompiledProgram(CPP, code, input, { ...rest, sandboxes });
}
