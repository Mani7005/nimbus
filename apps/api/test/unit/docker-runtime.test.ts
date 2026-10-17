// Mocked: no Docker daemon or real process is used. See test/integration for real Docker tests.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  DEFAULT_SANDBOX,
  HARD_TIMEOUT_GRACE_MS,
  buildDockerRunArgs,
  removeContainer,
  runContainer,
  type RunContainerOptions,
  type SandboxOptions,
} from "../../src/runtime/docker.js";
import { createFakeDocker } from "./fakes.js";

const WORKSPACE = "C:\\Users\\Some User\\AppData\\Local\\Temp\\nimbus-x\\workspace";

function options(overrides: Partial<RunContainerOptions> = {}): RunContainerOptions {
  return {
    containerName: "nimbus-run-test",
    cidFile: "C:\\tmp\\nimbus-x\\run.cid",
    workspaceDir: WORKSPACE,
    command: ["bash", "-c", "./main < input.txt"],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    terminateOnOutputLimit: true,
    killGraceMs: 50,
    ...overrides,
  };
}

describe("buildDockerRunArgs", () => {
  it("builds the sandboxed docker run argument list", () => {
    assert.deepEqual(buildDockerRunArgs(options()), [
      "run",
      "--rm",
      "--init",
      "--name", "nimbus-run-test",
      "--cidfile", "C:\\tmp\\nimbus-x\\run.cid",
      "--pull=never",
      "--network=none",
      "--user", "65534:65534",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--pids-limit=64",
      "--memory=256m",
      "--memory-swap=256m",
      "--cpus=1",
      "--ulimit", `fsize=${32 * 1024 * 1024}`,
      "-v", `${WORKSPACE}:/workspace`,
      "-w", "/workspace",
      "gcc:14",
      "timeout", "--signal=KILL", "3s",
      "bash", "-c", "./main < input.txt",
    ]);
  });

  it("mounts the workspace read-only when requested", () => {
    const args = buildDockerRunArgs(options({ readOnlyWorkspace: true }));
    assert.ok(args.includes(`${WORKSPACE}:/workspace:ro`));
  });

  it("applies the configured sandbox limits and keeps swap equal to memory", () => {
    const sandbox: SandboxOptions = { ...DEFAULT_SANDBOX, memoryMb: 512, pidsLimit: 32, maxFileSizeBytes: 1024 };
    const args = buildDockerRunArgs(options({ sandbox }));
    assert.ok(args.includes("--memory=512m"));
    assert.ok(args.includes("--memory-swap=512m"));
    assert.ok(args.includes("--pids-limit=32"));
    assert.equal(args[args.indexOf("--ulimit") + 1], "fsize=1024");
  });

  it("starts the in-container hard timeout the grace period after the host timeout", () => {
    const args = buildDockerRunArgs(options({ timeoutMs: 10500 }));
    const timeoutAt = args.indexOf("timeout");
    assert.deepEqual(args.slice(timeoutAt, timeoutAt + 4), ["timeout", "--signal=KILL", `${(10500 + HARD_TIMEOUT_GRACE_MS) / 1000}s`, "bash"]);
    assert.equal(args[timeoutAt - 1], "gcc:14", "the timeout wraps the command, not docker options");
  });

  it("never runs the container as root or with extra privileges", () => {
    const args = buildDockerRunArgs(options());
    assert.notEqual(args[args.indexOf("--user") + 1].split(":")[0], "0");
    assert.ok(!args.some((arg) => arg.startsWith("--privileged") || arg.startsWith("--cap-add")));
  });

  it("keeps paths with spaces as single arguments and contains no shell line continuations", () => {
    const args = buildDockerRunArgs(options());
    assert.ok(args.includes(`${WORKSPACE}:/workspace`));
    for (const arg of args) assert.ok(!arg.includes("\n"), `argument contains a newline: ${JSON.stringify(arg)}`);
  });
});

describe("runContainer", () => {
  it("invokes the docker executable directly with an argument array and no shell", async () => {
    const fake = createFakeDocker({ onSpawn: (child) => child.close(0) });
    await runContainer(options(), fake.deps);

    assert.equal(fake.spawnCalls.length, 1);
    const [call] = fake.spawnCalls;
    assert.equal(call.command, "docker");
    assert.deepEqual(call.args, buildDockerRunArgs(options()));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
  });

  it("captures stdout, stderr and the real exit code", async () => {
    const fake = createFakeDocker({
      onSpawn: (child) => {
        child.stdout.write("hello\n");
        child.stderr.write("warning\n");
        setImmediate(() => child.close(3));
      },
    });
    const result = await runContainer(options(), fake.deps);

    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, "hello\n");
    assert.equal(result.stderr, "warning\n");
    assert.equal(result.terminationReason, null);
    assert.equal(result.containerCreated, true);
    assert.deepEqual(fake.removed, [], "a normally exiting container is removed by --rm, not by us");
  });

  it("reports when Docker never created the container", async () => {
    const fake = createFakeDocker({ containerId: "", onSpawn: (child) => child.close(1) });
    const result = await runContainer(options(), fake.deps);
    assert.equal(result.containerCreated, false);
    assert.equal(result.exitCode, 1);
  });

  it("removes the named container on timeout and removes it again after the CLI exits", async () => {
    const fake = createFakeDocker();
    const result = await runContainer(options({ timeoutMs: 20 }), fake.deps);

    assert.equal(result.terminationReason, "timeout");
    assert.equal(result.exitCode, 137);
    assert.deepEqual(fake.removed, ["nimbus-run-test", "nimbus-run-test"]);
    assert.deepEqual(fake.child.killSignals, [], "the CLI ended once the container was removed");
  });

  it("kills the Docker CLI when removing the container does not end it", async () => {
    const fake = createFakeDocker({ onRemove: () => undefined });
    const result = await runContainer(options({ timeoutMs: 20, killGraceMs: 20 }), fake.deps);

    assert.equal(result.terminationReason, "timeout");
    assert.deepEqual(fake.child.killSignals, ["SIGKILL"]);
    assert.equal(result.exitCode, null);
    assert.equal(fake.removed.length, 2);
  });

  it("does not time out a process that exits before the deadline", async () => {
    const fake = createFakeDocker({ onSpawn: (child) => child.close(0) });
    const result = await runContainer(options({ timeoutMs: 30 }), fake.deps);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(result.terminationReason, null);
    assert.deepEqual(fake.removed, []);
  });

  it("treats a run that ends at the deadline before the host timer fires as a timeout", async () => {
    // The in-container timeout killed the program (exit 137) while the host timer was delayed.
    const fake = createFakeDocker({ onSpawn: (child) => child.close(137) });
    let clock = 0;
    fake.deps.now = () => (clock += 1000);
    const result = await runContainer(options({ timeoutMs: 1000 }), fake.deps);

    assert.equal(result.terminationReason, "timeout");
    assert.equal(result.exitCode, 137);
    assert.deepEqual(fake.removed, [], "the container already exited, so there is nothing to remove");
  });

  it("does not treat a run that ends before the deadline as a timeout", async () => {
    const fake = createFakeDocker({ onSpawn: (child) => child.close(137) });
    let clock = 0;
    fake.deps.now = () => (clock += 400);
    const result = await runContainer(options({ timeoutMs: 1000 }), fake.deps);
    assert.equal(result.terminationReason, null);
  });

  it("caps output while streaming and terminates when the limit is exceeded", async () => {
    const fake = createFakeDocker({
      onSpawn: (child) => {
        child.stdout.write("x".repeat(8));
        child.stdout.write("y".repeat(8));
        child.stdout.write("z".repeat(1000));
      },
    });
    const result = await runContainer(options({ maxOutputBytes: 10 }), fake.deps);

    assert.equal(result.terminationReason, "output_limit");
    assert.equal(result.outputTruncated, true);
    assert.equal(result.stdout, "xxxxxxxxyy");
    assert.equal(fake.removed[0], "nimbus-run-test");
  });

  it("applies the limit to stderr independently", async () => {
    const fake = createFakeDocker({ onSpawn: (child) => child.stderr.write("e".repeat(50)) });
    const result = await runContainer(options({ maxOutputBytes: 10 }), fake.deps);
    assert.equal(result.terminationReason, "output_limit");
    assert.equal(result.stderr.length, 10);
  });

  it("caps but does not terminate when terminateOnOutputLimit is false", async () => {
    const fake = createFakeDocker({
      onSpawn: (child) => {
        child.stderr.write("e".repeat(50));
        setImmediate(() => child.close(1));
      },
    });
    const result = await runContainer(options({ maxOutputBytes: 10, terminateOnOutputLimit: false }), fake.deps);

    assert.equal(result.terminationReason, null);
    assert.equal(result.outputTruncated, true);
    assert.equal(result.stderr, "e".repeat(10));
    assert.equal(result.exitCode, 1);
  });

  it("does not truncate output exactly at the limit", async () => {
    const fake = createFakeDocker({
      onSpawn: (child) => {
        child.stdout.write("a".repeat(10));
        setImmediate(() => child.close(0));
      },
    });
    const result = await runContainer(options({ maxOutputBytes: 10 }), fake.deps);
    assert.equal(result.outputTruncated, false);
    assert.equal(result.terminationReason, null);
  });

  it("resolves with a spawn error when the docker executable is missing", async () => {
    const fake = createFakeDocker({
      containerId: "",
      onSpawn: (child) => {
        child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
        child.close(-4058);
      },
    });
    const result = await runContainer(options(), fake.deps);

    assert.match(result.spawnError?.message ?? "", /ENOENT/);
    assert.equal(result.exitCode, null, "the first event settles the result exactly once");
    assert.equal(result.containerCreated, false);
  });

  it("resolves with a spawn error when spawn throws synchronously", async () => {
    const fake = createFakeDocker({ containerId: "" });
    fake.deps.spawn = () => {
      throw new Error("spawn EINVAL");
    };
    const result = await runContainer(options(), fake.deps);
    assert.equal(result.spawnError?.message, "spawn EINVAL");
  });
});

describe("removeContainer", () => {
  it("force-removes by name without a shell and resolves even when docker fails", async () => {
    const calls: { command: string; args: readonly string[]; shell: unknown }[] = [];
    await removeContainer("nimbus-run-test", (command, args, spawnOptions) => {
      calls.push({ command, args, shell: spawnOptions.shell });
      const child = new EventEmitter();
      setImmediate(() => child.emit("error", new Error("spawn docker ENOENT")));
      return child as unknown as ChildProcess;
    });

    assert.deepEqual(calls, [{ command: "docker", args: ["rm", "-f", "nimbus-run-test"], shell: false }]);
  });
});
