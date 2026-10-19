// REAL Docker: runs eclipse-temurin containers. Skipped unless NIMBUS_DOCKER_INTEGRATION=1.
// Requires a running Docker daemon and the pinned image pre-pulled (`docker pull <JAVA_IMAGE>`), since runs use --pull=never.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExecutionLimits } from "../../src/adapters/compiled-program.js";
import {
  DEFAULT_JAVA_SANDBOXES,
  JAVA_COMPILE_COMMAND,
  JAVA_RUN_COMMAND,
  MISSING_MAIN_CLASS_OUTPUT,
  executeJava,
} from "../../src/adapters/java.adapter.js";
import { HARD_TIMEOUT_GRACE_MS, buildDockerRunArgs, type DockerRunSpec } from "../../src/runtime/docker.js";
import { leakedExecutionContainers } from "./docker-helpers.js";

const enabled = process.env.NIMBUS_DOCKER_INTEGRATION === "1";
const LIMITS: ExecutionLimits = { compileTimeoutMs: 60000, runTimeoutMs: 5000, maxOutputBytes: 4096 };

function main(...body: string[]): string {
  return ["import java.io.*;", "import java.nio.file.*;", "import java.util.*;", "", "public class Main {", "  public static void main(String[] args) throws Exception {", ...body.map((line) => `    ${line}`), "  }", "}"].join("\n");
}

// Spins after starting five long-lived child processes, so only a process-group kill ends all of them.
const FORK_AND_SPIN = main('for (int i = 0; i < 5; i++) new ProcessBuilder("sleep", "300").start();', "while (true) {}");

/** Runs one container with the production flags, outside runContainer: no host-side timeout or removal. */
function dockerRun(spec: Omit<DockerRunSpec, "containerName" | "cidFile">, stage: "compile" | "run", dir: string) {
  const args = buildDockerRunArgs({ ...spec, containerName: `nimbus-${stage}-${randomUUID()}`, cidFile: path.join(dir, `${stage}-${randomUUID()}.cid`) });
  return spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
}

/** Writes and compiles Main.java in a workspace laid out like executeCompiledProgram's. */
async function compiledWorkspace(code: string, input = ""): Promise<{ dir: string; workspaceDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nimbus-it-"));
  const workspaceDir = path.join(dir, "workspace");
  await fs.mkdir(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "Main.java"), code);
  await fs.writeFile(path.join(workspaceDir, "input.txt"), input);
  await fs.chmod(workspaceDir, 0o777);
  const compile = dockerRun({ workspaceDir, command: JAVA_COMPILE_COMMAND, timeoutMs: LIMITS.compileTimeoutMs, sandbox: DEFAULT_JAVA_SANDBOXES.compile }, "compile", dir);
  assert.equal(compile.status, 0, `javac failed: ${compile.stderr}`);
  return { dir, workspaceDir };
}

describe("executeJava with real Docker", { skip: enabled ? false : "set NIMBUS_DOCKER_INTEGRATION=1 to run", timeout: 300000 }, () => {
  it("runs a program with stdin", async () => {
    const code = main("Scanner in = new Scanner(System.in);", "System.out.print(in.nextInt() + in.nextInt());");
    const result = await executeJava(code, "2 40", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.equal(result.stdout, "42");
  });

  it("reads and writes UTF-8 on stdin, stdout and stderr", async () => {
    const code = main(
      "String word = new Scanner(System.in).next();",
      'System.out.print(word + " ü→✓");',
      'System.err.print("é");',
    );
    const result = await executeJava(code, "héllo", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.equal(result.stdout, "héllo ü→✓");
    assert.equal(result.stderr, "é");
  });

  it("reports javac errors", async () => {
    const result = await executeJava("public class Main { void f() { int x = } }", "", { limits: LIMITS });
    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.match(result.compileOutput, /Main\.java:1: error: illegal start of expression/);
  });

  it("reports a public class with the wrong name using javac's message", async () => {
    const result = await executeJava("public class Solution { public static void main(String[] a) {} }", "", { limits: LIMITS });
    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.match(result.compileOutput, /class Solution is public, should be declared in a file named Solution\.java/);
  });

  it("reports a missing Main class", async () => {
    const result = await executeJava("class Solution { public static void main(String[] a) {} }", "", { limits: LIMITS });
    assert.equal(result.outcome, "COMPILATION_ERROR");
    assert.equal(result.compileOutput, MISSING_MAIN_CLASS_OUTPUT);
  });

  it("reports System.exit codes", async () => {
    const result = await executeJava(main("System.exit(3);"), "", { limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR");
    assert.equal(result.exitCode, 3);
  });

  it("reports uncaught exceptions with their stack trace", async () => {
    const result = await executeJava(main('throw new IllegalStateException("boom");'), "", { limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^Exception in thread "main" java\.lang\.IllegalStateException: boom\n\s+at Main\.main\(Main\.java:7\)/);
  });

  it("kills the container on timeout", async () => {
    const result = await executeJava(main("while (true) {}"), "", { limits: LIMITS });
    assert.equal(result.outcome, "TIMEOUT");
    assert.deepEqual(leakedExecutionContainers(), [], "no execution container may survive a timeout");
  });

  it("kills a timed-out program's child processes with its container", async () => {
    const result = await executeJava(FORK_AND_SPIN, "", { limits: LIMITS });
    assert.equal(result.outcome, "TIMEOUT");
    assert.deepEqual(leakedExecutionContainers(), [], "forked children must not keep the container alive");
  });

  it("terminates on excessive output", async () => {
    const result = await executeJava(main('while (true) System.out.println("spam");'), "", { limits: LIMITS });
    assert.equal(result.outcome, "OUTPUT_LIMIT_EXCEEDED");
    assert.ok(result.stdout.length <= LIMITS.maxOutputBytes);
    assert.deepEqual(leakedExecutionContainers(), [], "no execution container may survive an output-limit kill");
  });

  it("runs as an unprivileged user with no effective capabilities", async () => {
    const code = main(
      'for (String line : Files.readAllLines(Path.of("/proc/self/status")))',
      '  if (line.startsWith("Uid:") || line.startsWith("CapEff:")) System.out.println(line.split("\\\\s+")[1]);',
    );
    const result = await executeJava(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.equal(result.stdout, "65534\n0000000000000000");
  });

  it("can write only to /tmp while running", async () => {
    const code = main(
      'String[] paths = { "/workspace/out.txt", "/etc/nimbus", "/tmp/scratch" };',
      "StringBuilder out = new StringBuilder();",
      "for (String p : paths) {",
      '  try (FileOutputStream f = new FileOutputStream(p)) { out.append("1 "); } catch (IOException e) { out.append("0 "); }',
      "}",
      "System.out.print(out.toString().trim());",
    );
    const result = await executeJava(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message);
    assert.equal(result.stdout, "0 0 1");
  });

  it("limits the number of threads and processes", async () => {
    const code = main(
      "int n = 0;",
      "try {",
      "  for (; n < 1000; n++) {",
      "    Thread t = new Thread(() -> { try { Thread.sleep(60000); } catch (InterruptedException e) {} });",
      "    t.setDaemon(true);",
      "    t.start();",
      "  }",
      "} catch (OutOfMemoryError e) {}",
      'System.out.print("started=" + n);',
      "System.exit(0);",
    );
    const result = await executeJava(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "SUCCESS", result.compileOutput || result.message || result.stderr);
    // The JVM logs the failed pthread_create to stdout, ahead of the program's own output.
    assert.match(result.stdout, /\[warning\]\[os,thread\] Failed to start thread .*EAGAIN/);
    const started = Number(/started=(\d+)$/.exec(result.stdout)?.[1]);
    assert.ok(started > 0 && started < DEFAULT_JAVA_SANDBOXES.run.pidsLimit, `started ${started} threads`);
    assert.deepEqual(leakedExecutionContainers(), []);
  });

  it("stops a program that exhausts its heap", async () => {
    const code = main("List<byte[]> hog = new ArrayList<>();", "while (true) hog.add(new byte[8 << 20]);");
    const result = await executeJava(code, "", { limits: LIMITS });
    assert.equal(result.outcome, "RUNTIME_ERROR", result.compileOutput || result.message);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /java\.lang\.OutOfMemoryError: Java heap space/);
  });

  it("enforces the file-size limit", async () => {
    const code = main(
      "byte[] buf = new byte[1 << 20];",
      'try (FileOutputStream f = new FileOutputStream("/tmp/big")) { for (int i = 0; i < 40; i++) f.write(buf); }',
      'System.out.print("not limited");',
    );
    const result = await executeJava(code, "", { limits: LIMITS });
    // HotSpot ignores SIGXFSZ, so the limit surfaces as an IOException rather than exit code 153.
    assert.equal(result.outcome, "RUNTIME_ERROR", result.compileOutput || result.message);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /java\.io\.IOException: File too large/);
    assert.equal(result.stdout, "");
  });

  it("kills the program and its children inside the container even when the host never removes it", async () => {
    const { dir, workspaceDir } = await compiledWorkspace(FORK_AND_SPIN);
    try {
      const timeoutMs = 1000;
      const started = Date.now();
      const run = dockerRun({ workspaceDir, command: JAVA_RUN_COMMAND, timeoutMs, readOnlyWorkspace: true, sandbox: DEFAULT_JAVA_SANDBOXES.run }, "run", dir);
      // GNU timeout signals the whole process group, itself included, so it reports 128 + SIGKILL.
      assert.equal(run.status, 137, `exit ${run.status}: ${run.stderr}`);
      assert.ok(Date.now() - started >= timeoutMs + HARD_TIMEOUT_GRACE_MS);
      assert.deepEqual(leakedExecutionContainers(), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves no child process alive after the in-container timeout fires", async () => {
    const { dir, workspaceDir } = await compiledWorkspace(FORK_AND_SPIN);
    try {
      // Runs the production run command under the image's timeout as a child of a shell that outlives it, so any
      // surviving process is still visible. The container's own outer timeout still applies.
      const [, , runScript] = JAVA_RUN_COMMAND;
      const probe = [
        `timeout --signal=KILL 1s bash -c '${runScript}'`,
        'echo "exit=$?"',
        "sleep 0.5",
        "n=0",
        'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < "$p/cmdline" 2>/dev/null)" in "sleep 300 "|java*) n=$((n+1));; esac; done',
        'echo "survivors=$n"',
      ].join("\n");
      const run = dockerRun(
        { workspaceDir, command: ["bash", "-c", probe], timeoutMs: 10000, readOnlyWorkspace: true, sandbox: DEFAULT_JAVA_SANDBOXES.run },
        "run",
        dir,
      );
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), "exit=137\nsurvivors=0");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
