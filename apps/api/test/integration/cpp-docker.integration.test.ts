// REAL Docker: runs gcc:14 containers. Skipped unless NIMBUS_DOCKER_INTEGRATION=1.
// Requires a running Docker daemon and a pre-pulled image (`docker pull gcc:14`), since runs use --pull=never.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { executeCpp, type CppExecutionLimits } from "../../src/adapters/cpp.adapter.js";

const enabled = process.env.NIMBUS_DOCKER_INTEGRATION === "1";
const LIMITS: CppExecutionLimits = { compileTimeoutMs: 60000, runTimeoutMs: 5000, maxOutputBytes: 4096 };

// Matches only the per-execution containers named in executeCpp, not nimbus-postgres / nimbus-redis.
const EXECUTION_CONTAINER_NAME = /^nimbus-(compile|run)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function leakedExecutionContainers(): string[] {
  const names = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  return names.split(/\r?\n/).map((name) => name.trim()).filter((name) => EXECUTION_CONTAINER_NAME.test(name));
}

describe("executeCpp with real Docker", { skip: enabled ? false : "set NIMBUS_DOCKER_INTEGRATION=1 to run", timeout: 300000 }, () => {
  it("runs a program with stdin", async () => {
    const code = "#include <iostream>\nint main() { int a, b; std::cin >> a >> b; std::cout << a + b; }";
    const result = await executeCpp(code, "2 40", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.message);
    assert.equal(result.stdout, "42");
  });

  it("reports compiler errors", async () => {
    const result = await executeCpp("int main() { return }", "", { limits: LIMITS });
    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.match(result.compileOutput, /error/);
  });

  it("keeps warnings on a successful run", async () => {
    const result = await executeCpp("int main() { int unused; return 0; }", "", { limits: LIMITS });
    // g++ does not warn without -Wall; this only checks warnings never cause failure.
    assert.equal(result.outcome, "SUCCESS", result.message);
  });

  it("reports non-zero exit codes", async () => {
    const result = await executeCpp("int main() { return 3; }", "", { limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR");
    assert.equal(result.exitCode, 3);
  });

  it("kills the container on timeout", async () => {
    const result = await executeCpp("int main() { for (;;) {} }", "", { limits: LIMITS });
    assert.equal(result.outcome, "TIMEOUT");
    assert.deepEqual(leakedExecutionContainers(), [], "no execution container may survive a timeout");
  });

  it("terminates on excessive output", async () => {
    const result = await executeCpp("#include <cstdio>\nint main() { for (;;) std::puts(\"spam\"); }", "", { limits: LIMITS });
    assert.equal(result.outcome, "OUTPUT_LIMIT_EXCEEDED");
    assert.ok(result.stdout.length <= LIMITS.maxOutputBytes);
    assert.deepEqual(leakedExecutionContainers(), [], "no execution container may survive an output-limit kill");
  });
});
