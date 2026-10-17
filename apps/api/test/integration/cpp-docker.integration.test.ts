// REAL Docker: runs gcc:14 containers. Skipped unless NIMBUS_DOCKER_INTEGRATION=1.
// Requires a running Docker daemon and a pre-pulled image (`docker pull gcc:14`), since runs use --pull=never.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CPP_SANDBOXES, executeCpp, type CppExecutionLimits } from "../../src/adapters/cpp.adapter.js";
import { HARD_TIMEOUT_GRACE_MS, buildDockerRunArgs } from "../../src/runtime/docker.js";

const enabled = process.env.NIMBUS_DOCKER_INTEGRATION === "1";
const LIMITS: CppExecutionLimits = { compileTimeoutMs: 60000, runTimeoutMs: 5000, maxOutputBytes: 4096 };

// Matches only the per-execution containers named in executeCpp, not nimbus-postgres / nimbus-redis.
const EXECUTION_CONTAINER_NAME = /^nimbus-(compile|run)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Containers labelled nimbus.test are deliberate stand-ins started by container-cleanup.integration.test.ts.
function leakedExecutionContainers(): string[] {
  const lines = execFileSync("docker", ["ps", "-a", "--format", '{{.Names}}|{{.Label "nimbus.test"}}'], { encoding: "utf8" });
  return lines
    .split(/\r?\n/)
    .map((line) => line.trim().split("|"))
    .filter(([name, testLabel]) => EXECUTION_CONTAINER_NAME.test(name) && !testLabel)
    .map(([name]) => name);
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

  it("compiles bits/stdc++.h within the compile memory limit", async () => {
    const code = "#include <bits/stdc++.h>\nint main() { std::vector<int> v{3, 1, 2}; std::sort(v.begin(), v.end()); std::cout << v[0]; }";
    const result = await executeCpp(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.equal(result.stdout, "1");
  });

  it("runs as an unprivileged user with no effective capabilities", async () => {
    const code = [
      "#include <cstdio>",
      "#include <fstream>",
      "#include <string>",
      "#include <unistd.h>",
      "int main() {",
      '  std::ifstream status("/proc/self/status");',
      "  std::string line, caps;",
      '  while (std::getline(status, line)) if (line.rfind("CapEff:", 0) == 0) caps = line.substr(7);',
      '  std::printf("%d %s", (int)getuid(), caps.c_str());',
      "}",
    ].join("\n");
    const result = await executeCpp(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.match(result.stdout, /^65534\s+0{16}$/);
  });

  it("can write only to /tmp while running", async () => {
    const code = [
      "#include <cstdio>",
      "int main() {",
      '  std::printf("%d %d %d", std::fopen("/workspace/out.txt", "w") != nullptr, std::fopen("/etc/nimbus", "w") != nullptr,',
      '              std::fopen("/tmp/scratch", "w") != nullptr);',
      "}",
    ].join("\n");
    const result = await executeCpp(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.equal(result.stdout, "0 0 1");
  });

  it("limits the number of processes", async () => {
    const code = [
      "#include <cstdio>",
      "#include <unistd.h>",
      "int main() {",
      "  int n = 0;",
      "  for (int i = 0; i < 1000; i++) { pid_t p = fork(); if (p == 0) { pause(); _exit(0); } if (p < 0) break; n++; }",
      '  std::printf("%d", n);',
      "}",
    ].join("\n");
    const result = await executeCpp(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.ok(Number(result.stdout) < DEFAULT_CPP_SANDBOXES.run.pidsLimit, `forked ${result.stdout} processes`);
    assert.deepEqual(leakedExecutionContainers(), [], "forked children must not keep the container alive");
  });

  it("enforces the file-size limit", async () => {
    const code = [
      "#include <cstdio>",
      "#include <vector>",
      "int main() {",
      '  std::FILE* f = std::fopen("/tmp/big", "w");',
      "  std::vector<char> buf(1 << 20, 'x');",
      "  for (int i = 0; i < 40; i++) std::fwrite(buf.data(), 1, buf.size(), f);",
      "  std::fclose(f);",
      '  std::puts("not limited");',
      "}",
    ].join("\n");
    const result = await executeCpp(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR", result.compileOutput || result.message);
    assert.equal(result.exitCode, 153);
    assert.match(result.message, /SIGXFSZ/);
  });

  it("kills a program that exceeds the memory limit without swapping", async () => {
    const code = "#include <cstdio>\n#include <vector>\nint main() { std::vector<char> v(512u << 20, 1); std::printf(\"%d\", v[12345]); }";
    const result = await executeCpp(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR", result.compileOutput || result.message);
    assert.equal(result.exitCode, 137);
  });

  it("reports a segmentation fault with its signal", async () => {
    const result = await executeCpp("int main() { volatile int* p = nullptr; *p = 1; }", "", { limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR");
    assert.equal(result.exitCode, 139);
  });

  it("kills the program inside the container even when the host never removes it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbus-it-"));
    try {
      const workspaceDir = path.join(dir, "workspace");
      await fs.mkdir(workspaceDir);
      const args = buildDockerRunArgs({
        containerName: `nimbus-run-${randomUUID()}`,
        cidFile: path.join(dir, "run.cid"),
        workspaceDir,
        command: ["bash", "-c", "while :; do :; done"],
        timeoutMs: 1000,
        readOnlyWorkspace: true,
      });
      // No host-side timeout or removal: only the in-container timeout can end this.
      const started = Date.now();
      const run = spawnSync("docker", args, { encoding: "utf8", timeout: 60000 });
      assert.ok(run.status === 137 || run.status === 124, `exit ${run.status}: ${run.stderr}`);
      assert.ok(Date.now() - started >= 1000 + HARD_TIMEOUT_GRACE_MS);
      assert.deepEqual(leakedExecutionContainers(), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
