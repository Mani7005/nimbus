export type ExecutionOutcome =
  | "SUCCESS"
  | "COMPILATION_ERROR"
  | "RUNTIME_ERROR"
  | "TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "INFRASTRUCTURE_ERROR";

/** Values persisted in Execution.status and understood by the web client. */
export type ExecutionStatus = "COMPLETED" | "FAILED" | "TIMEOUT";

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  stdout: string;
  stderr: string;
  /** Compiler diagnostics; when the outcome is not COMPILATION_ERROR these are warnings only. */
  compileOutput: string;
  exitCode: number | null;
  /** Detail for runtime errors, timeouts, output overflow and infrastructure errors. */
  message: string;
}

export const INFRASTRUCTURE_ERROR_OUTPUT = "Execution could not be completed due to an internal error. Please try again.";

export function toExecutionStatus(outcome: ExecutionOutcome): ExecutionStatus {
  if (outcome === "SUCCESS") return "COMPLETED";
  if (outcome === "TIMEOUT") return "TIMEOUT";
  return "FAILED";
}

function section(label: string, text: string): string {
  return text ? `[${label}]\n${text}` : "";
}

function joinParts(...parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

/** Builds the single `output` string stored on the execution and shown by the web client. */
export function formatExecutionOutput(result: ExecutionResult): string {
  switch (result.outcome) {
    case "SUCCESS":
      return joinParts(result.stdout, section("stderr", result.stderr), section("compiler warnings", result.compileOutput));
    case "COMPILATION_ERROR":
      return result.compileOutput || "Compilation failed";
    case "RUNTIME_ERROR":
      return joinParts(result.stdout, section("stderr", result.stderr), result.message);
    case "TIMEOUT":
      return joinParts(result.message, result.stdout);
    case "OUTPUT_LIMIT_EXCEEDED":
      return joinParts(result.stdout, section("stderr", result.stderr), result.message);
    case "INFRASTRUCTURE_ERROR":
      return INFRASTRUCTURE_ERROR_OUTPUT;
  }
}
