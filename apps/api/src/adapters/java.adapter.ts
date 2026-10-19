import fs from "fs/promises";
import path from "path";
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

/**
 * Pinned by digest (multi-arch index). The Ubuntu 24.04 "noble" variant ships GNU `timeout`, which kills the whole
 * process group; the uutils `timeout` in newer Ubuntu bases only signals its direct child.
 */
export const JAVA_IMAGE = "eclipse-temurin:21-jdk-noble@sha256:107215954359f1ab0be058a247d7c64ed6e69c71c1682d471d38ef751ec8e964";

export const DEFAULT_JAVA_LIMITS: ExecutionLimits = DEFAULT_EXECUTION_LIMITS;

// Same limits as C++; only the image differs.
export const DEFAULT_JAVA_SANDBOXES: StageSandboxes = {
  compile: configuredSandbox(sandboxConfig.compileMemoryMb, JAVA_IMAGE),
  run: configuredSandbox(sandboxConfig.runMemoryMb, JAVA_IMAGE),
};

export interface ExecuteJavaOptions {
  runner?: ContainerRunner;
  limits?: ExecutionLimits;
  sandboxes?: StageSandboxes;
}

// The serial collector keeps the JVM's thread count well under the pids limit, and disabling perf data stops it
// writing to /tmp. Half the container memory as heap leaves room for the JVM itself, so running out of heap is an
// OutOfMemoryError rather than the container being killed.
const JVM_FLAGS = ["-XX:+UseSerialGC", "-XX:-UsePerfData"] as const;

// Fixed commands: submitted code and stdin only reach the container as files in the mounted workspace.
export const JAVA_COMPILE_COMMAND = ["javac", ...JVM_FLAGS.map((flag) => `-J${flag}`), "-encoding", "UTF-8", "Main.java"] as const;
export const JAVA_RUN_COMMAND = ["bash", "-c", `java ${JVM_FLAGS.join(" ")} -XX:MaxRAMPercentage=50 -cp . Main < input.txt`] as const;

export const MISSING_MAIN_CLASS_OUTPUT = "No class named Main was found. Declare `public class Main` with a `public static void main(String[] args)` method.";

/** javac succeeds without producing Main.class when the file declares only other, non-public classes. */
async function checkMainClass(workspaceDir: string): Promise<string | null> {
  const stats = await fs.lstat(path.join(workspaceDir, "Main.class")).catch(() => null);
  return stats?.isFile() ? null : MISSING_MAIN_CLASS_OUTPUT;
}

const JAVA: CompiledLanguage = {
  sourceFile: "Main.java",
  compileCommand: JAVA_COMPILE_COMMAND,
  runCommand: JAVA_RUN_COMMAND,
  checkCompiled: checkMainClass,
};

export function executeJava(code: string, input: string, options: ExecuteJavaOptions = {}): Promise<ExecutionResult> {
  const { sandboxes = DEFAULT_JAVA_SANDBOXES, ...rest } = options;
  return executeCompiledProgram(JAVA, code, input, { ...rest, sandboxes });
}
