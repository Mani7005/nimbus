import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INFRASTRUCTURE_ERROR_OUTPUT,
  formatExecutionOutput,
  toExecutionStatus,
  type ExecutionResult,
} from "../../src/runtime/execution-result.js";

function result(fields: Partial<ExecutionResult> & Pick<ExecutionResult, "outcome">): ExecutionResult {
  return { stdout: "", stderr: "", compileOutput: "", exitCode: 0, message: "", ...fields };
}

describe("toExecutionStatus", () => {
  it("maps outcomes onto the persisted status values", () => {
    assert.equal(toExecutionStatus("SUCCESS"), "COMPLETED");
    assert.equal(toExecutionStatus("TIMEOUT"), "TIMEOUT");
    for (const outcome of ["COMPILATION_ERROR", "RUNTIME_ERROR", "OUTPUT_LIMIT_EXCEEDED", "INFRASTRUCTURE_ERROR"] as const) {
      assert.equal(toExecutionStatus(outcome), "FAILED");
    }
  });
});

describe("formatExecutionOutput", () => {
  it("returns plain stdout for a clean successful run, as before", () => {
    assert.equal(formatExecutionOutput(result({ outcome: "SUCCESS", stdout: "Hello Nimbus" })), "Hello Nimbus");
  });

  it("returns an empty string for a successful run with no output", () => {
    assert.equal(formatExecutionOutput(result({ outcome: "SUCCESS" })), "");
  });

  it("appends program stderr and compiler warnings in labelled sections after stdout", () => {
    assert.equal(
      formatExecutionOutput(result({ outcome: "SUCCESS", stdout: "42", stderr: "debug", compileOutput: "warning: unused" })),
      "42\n\n[stderr]\ndebug\n\n[compiler warnings]\nwarning: unused",
    );
  });

  it("returns the raw compiler output for compilation errors, as before", () => {
    assert.equal(formatExecutionOutput(result({ outcome: "COMPILATION_ERROR", compileOutput: "error: x" })), "error: x");
  });

  it("includes the exit description for runtime errors", () => {
    assert.equal(
      formatExecutionOutput(result({ outcome: "RUNTIME_ERROR", stdout: "partial", stderr: "boom", message: "Process exited with code 1" })),
      "partial\n\n[stderr]\nboom\n\nProcess exited with code 1",
    );
  });

  it("leads with the timeout message", () => {
    assert.equal(
      formatExecutionOutput(result({ outcome: "TIMEOUT", stdout: "tick", message: "Execution Timed Out (limit 10s)" })),
      "Execution Timed Out (limit 10s)\n\ntick",
    );
  });

  it("hides infrastructure details from users", () => {
    assert.equal(formatExecutionOutput(result({ outcome: "INFRASTRUCTURE_ERROR", message: "npipe secret path" })), INFRASTRUCTURE_ERROR_OUTPUT);
  });
});
