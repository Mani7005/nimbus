// Mocked: no Docker daemon or real process is used. See test/integration for the real Docker cleanup test.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import {
  cleanupLeakedContainers,
  createDockerCleanupCli,
  parseInspectOutput,
  selectStaleContainers,
  type ContainerCleanupDocker,
  type ContainerInfo,
} from "../../src/runtime/container-cleanup.js";
import type { SpawnFn } from "../../src/runtime/docker.js";
import { FakeChild } from "./fakes.js";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NOW = new Date("2026-10-17T12:00:00Z");
const MIN_AGE_MS = 10 * 60_000;

let nextId = 0;
function container(name: string, ageMs: number, state = "running"): ContainerInfo {
  const id = (nextId++).toString(16).padStart(64, "0");
  return { id, name, createdAt: new Date(NOW.getTime() - ageMs), state };
}

function silentLogger() {
  const lines: string[] = [];
  const record = (line: string) => void lines.push(line);
  return { lines, logger: { log: record, warn: record, error: record } };
}

function fakeDocker(containers: ContainerInfo[], overrides: Partial<ContainerCleanupDocker> = {}) {
  const removed: string[] = [];
  const docker: ContainerCleanupDocker = {
    daemonTime: async () => NOW,
    listExecutionContainers: async () => containers,
    remove: async (id) => void removed.push(id),
    ...overrides,
  };
  return { docker, removed };
}

describe("selectStaleContainers", () => {
  it("selects only execution containers by exact name", () => {
    const old = 60 * 60_000;
    const containers = [
      container(`nimbus-compile-${UUID}`, old),
      container(`nimbus-run-${UUID}`, old),
      container("nimbus-postgres", old),
      container("nimbus-redis", old),
      container("nimbus-run-not-a-uuid", old),
      container(`nimbus-run-${UUID}-copy`, old),
      container(`other-nimbus-run-${UUID}`, old),
      container(`nimbus-run-${UUID.toUpperCase()}`, old),
      container(`nimbus-exec-${UUID}`, old),
    ];
    assert.deepEqual(
      selectStaleContainers(containers, NOW, MIN_AGE_MS).map((c) => c.name),
      [`nimbus-compile-${UUID}`, `nimbus-run-${UUID}`],
    );
  });

  it("selects only containers strictly older than the minimum age", () => {
    const containers = [
      container(`nimbus-run-${UUID}`, MIN_AGE_MS - 1),
      container(`nimbus-run-${UUID}`, MIN_AGE_MS),
      container(`nimbus-run-${UUID}`, MIN_AGE_MS + 1),
    ];
    assert.deepEqual(selectStaleContainers(containers, NOW, MIN_AGE_MS), [containers[2]]);
  });

  it("never selects containers with an unparseable or future creation time", () => {
    const invalid = { ...container(`nimbus-run-${UUID}`, 0), createdAt: new Date("garbage") };
    const future = container(`nimbus-run-${UUID}`, -60 * 60_000);
    assert.deepEqual(selectStaleContainers([invalid, future], NOW, MIN_AGE_MS), []);
  });
});

describe("cleanupLeakedContainers", () => {
  const stale = container(`nimbus-run-${UUID}`, MIN_AGE_MS + 1);
  const active = container(`nimbus-compile-${UUID}`, 5000);
  const postgres = container("nimbus-postgres", 30 * 24 * 60 * 60_000);

  it("removes only stale execution containers, leaving active executions and infrastructure alone", async () => {
    const { docker, removed } = fakeDocker([stale, active, postgres]);
    const { logger } = silentLogger();
    const summary = await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(removed, [stale.id]);
    assert.deepEqual(summary, { found: 2, stale: 1, removed: 1, errors: 0, aborted: false });
  });

  it("only logs in dry-run mode", async () => {
    const { docker, removed } = fakeDocker([stale, active]);
    const { logger, lines } = silentLogger();
    const summary = await cleanupLeakedContainers({ docker, mode: "dry-run", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(removed, []);
    assert.equal(summary.removed, 0);
    assert.equal(summary.stale, 1);
    assert.ok(lines.some((line) => line.includes("would remove") && line.includes(stale.name)));
  });

  it("does not touch Docker when off", async () => {
    let called = false;
    const touch = async (): Promise<never> => {
      called = true;
      throw new Error("must not be called");
    };
    const docker: ContainerCleanupDocker = { daemonTime: touch, listExecutionContainers: touch, remove: touch };
    const summary = await cleanupLeakedContainers({ docker, mode: "off", minAgeMs: MIN_AGE_MS, logger: silentLogger().logger });
    assert.equal(called, false);
    assert.equal(summary.aborted, false);
  });

  it("removes nothing when the daemon time cannot be read", async () => {
    const { docker, removed } = fakeDocker([stale], {
      daemonTime: async () => {
        throw new Error("Docker Desktop is not running");
      },
    });
    const { logger, lines } = silentLogger();
    const summary = await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(removed, []);
    assert.deepEqual(summary, { found: 0, stale: 0, removed: 0, errors: 1, aborted: true });
    assert.ok(lines.some((line) => line.includes("Docker Desktop is not running")));
  });

  it("removes nothing when listing fails", async () => {
    const { docker, removed } = fakeDocker([], {
      listExecutionContainers: async () => {
        throw new Error("docker ps exited with code 1");
      },
    });
    const { logger } = silentLogger();
    const summary = await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });
    assert.deepEqual(removed, []);
    assert.equal(summary.aborted, true);
  });

  it("continues after one removal fails", async () => {
    const first = container(`nimbus-run-${UUID}`, MIN_AGE_MS + 1);
    const second = container(`nimbus-compile-${UUID}`, MIN_AGE_MS + 1);
    const { docker, removed } = fakeDocker([first, second], {
      remove: async (id) => {
        if (id === first.id) throw new Error("removal already in progress");
        removed.push(id);
      },
    });
    const { logger } = silentLogger();
    const summary = await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(removed, [second.id]);
    assert.deepEqual(summary, { found: 2, stale: 2, removed: 1, errors: 1, aborted: false });
  });

  it("removes at most maxRemovals containers per run", async () => {
    const many = Array.from({ length: 5 }, () => container(`nimbus-run-${UUID}`, MIN_AGE_MS + 1));
    const { docker, removed } = fakeDocker(many);
    const { logger } = silentLogger();
    const summary = await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger, maxRemovals: 2 });
    assert.equal(removed.length, 2);
    assert.equal(summary.stale, 5);
  });

  it("measures age from the daemon clock read before listing", async () => {
    const order: string[] = [];
    // The container is 1 minute old by the daemon clock; the host clock is irrelevant.
    const young = container(`nimbus-run-${UUID}`, 60_000);
    const { docker, removed } = fakeDocker([young], {
      daemonTime: async () => (order.push("time"), NOW),
      listExecutionContainers: async () => (order.push("list"), [young]),
    });
    const { logger } = silentLogger();
    await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });
    assert.deepEqual(order, ["time", "list"]);
    assert.deepEqual(removed, []);
  });
});

describe("cleanup result logging", () => {
  function recordingLogger() {
    const entries: { level: string; line: string }[] = [];
    const at = (level: string) => (line: string) => void entries.push({ level, line });
    return { entries, logger: { log: at("log"), warn: at("warn"), error: at("error") } };
  }
  const resultLines = (entries: { level: string; line: string }[]) => entries.filter((e) => /^Container cleanup \(/.test(e.line));

  it("logs exactly one result line and nothing else when there is nothing to clean", async () => {
    const active = container(`nimbus-run-${UUID}`, 5000);
    const { docker } = fakeDocker([active, container("nimbus-redis", 60 * 60_000)]);
    const { logger, entries } = recordingLogger();
    await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(entries, [{ level: "log", line: "Container cleanup (remove): found 1, stale 0, removed 0, skipped 0, errors 0" }]);
  });

  it("reports stale containers a dry run left in place as skipped", async () => {
    const { docker } = fakeDocker([container(`nimbus-run-${UUID}`, MIN_AGE_MS + 1), container(`nimbus-compile-${UUID}`, 5000)]);
    const { logger, entries } = recordingLogger();
    await cleanupLeakedContainers({ docker, mode: "dry-run", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(resultLines(entries), [{ level: "log", line: "Container cleanup (dry-run): found 2, stale 1, removed 0, skipped 1, errors 0" }]);
  });

  it("logs that cleanup is off without querying Docker", async () => {
    const refuse = async (): Promise<never> => {
      throw new Error("must not be called");
    };
    const { logger, entries } = recordingLogger();
    await cleanupLeakedContainers({ docker: { daemonTime: refuse, listExecutionContainers: refuse, remove: refuse }, mode: "off", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(entries, [{ level: "log", line: "Container cleanup (off): disabled, Docker not queried" }]);
  });

  it("logs an aborted run as a warning that nothing was removed", async () => {
    const { docker } = fakeDocker([], {
      daemonTime: async () => {
        throw new Error("Docker Desktop is not running");
      },
    });
    const { logger, entries } = recordingLogger();
    await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(resultLines(entries), [{ level: "warn", line: "Container cleanup (remove): aborted, could not query Docker; nothing removed" }]);
  });

  it("logs failed removals as errors, not skips, at warning level", async () => {
    const failing = container(`nimbus-run-${UUID}`, MIN_AGE_MS + 1);
    const removable = container(`nimbus-compile-${UUID}`, MIN_AGE_MS + 1);
    const { docker } = fakeDocker([failing, removable], {
      remove: async (id) => {
        if (id === failing.id) throw new Error("removal already in progress");
      },
    });
    const { logger, entries } = recordingLogger();
    await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger });

    assert.deepEqual(resultLines(entries), [{ level: "warn", line: "Container cleanup (remove): found 2, stale 2, removed 1, skipped 0, errors 1" }]);
  });

  it("counts containers beyond the removal limit as skipped", async () => {
    const { docker } = fakeDocker(Array.from({ length: 5 }, () => container(`nimbus-run-${UUID}`, MIN_AGE_MS + 1)));
    const { logger, entries } = recordingLogger();
    await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: MIN_AGE_MS, logger, maxRemovals: 2 });

    assert.deepEqual(resultLines(entries), [{ level: "log", line: "Container cleanup (remove): found 5, stale 5, removed 2, skipped 3, errors 0" }]);
  });
});

describe("parseInspectOutput", () => {
  const id = "a".repeat(64);

  it("parses docker inspect lines and strips the leading slash from names", () => {
    const parsed = parseInspectOutput(`${id}|/nimbus-run-${UUID}|2026-10-17T11:00:00.123456789Z|running\r\n`);
    assert.deepEqual(parsed, [{ id, name: `nimbus-run-${UUID}`, createdAt: new Date("2026-10-17T11:00:00.123Z"), state: "running" }]);
  });

  it("drops malformed lines and docker error text", () => {
    const output = ["Error: No such object: abc", `${id}|/nimbus-run-${UUID}`, `not-an-id|/x|2026-10-17T11:00:00Z|running`, ""].join("\n");
    assert.deepEqual(parseInspectOutput(output), []);
  });
});

describe("createDockerCleanupCli", () => {
  type Script = { stdout?: string; stderr?: string; exitCode?: number };

  function scriptedSpawn(scripts: Script[]) {
    const calls: { command: string; args: readonly string[]; shell: unknown }[] = [];
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      const child = new FakeChild();
      const script = scripts.shift() ?? { exitCode: 0 };
      setImmediate(() => {
        if (script.stdout) child.stdout.write(script.stdout);
        if (script.stderr) child.stderr.write(script.stderr);
        setImmediate(() => child.close(script.exitCode ?? 0));
      });
      return child as unknown as ChildProcess;
    };
    return { spawn, calls };
  }

  const id = "b".repeat(64);

  it("lists by loose name filter, then inspects only well-formed ids, without a shell", async () => {
    const { spawn, calls } = scriptedSpawn([
      { stdout: `${id}\nnot-an-id\n` },
      { stdout: `${id}|/nimbus-run-${UUID}|2026-10-17T11:00:00Z|running\n` },
    ]);
    const containers = await createDockerCleanupCli(spawn).listExecutionContainers();

    assert.deepEqual(calls, [
      { command: "docker", args: ["ps", "--all", "--no-trunc", "--filter", "name=nimbus-", "--format", "{{.ID}}"], shell: false },
      { command: "docker", args: ["inspect", "--format", "{{.Id}}|{{.Name}}|{{.Created}}|{{.State.Status}}", id], shell: false },
    ]);
    assert.equal(containers[0].name, `nimbus-run-${UUID}`);
  });

  it("skips inspect when no containers are listed", async () => {
    const { spawn, calls } = scriptedSpawn([{ stdout: "" }]);
    assert.deepEqual(await createDockerCleanupCli(spawn).listExecutionContainers(), []);
    assert.equal(calls.length, 1);
  });

  it("rejects when docker ps fails", async () => {
    const { spawn } = scriptedSpawn([{ exitCode: 1, stderr: "failed to connect to the docker API" }]);
    await assert.rejects(createDockerCleanupCli(spawn).listExecutionContainers(), /docker ps exited with code 1/);
  });

  it("reads the daemon time and rejects an unparseable one", async () => {
    const ok = scriptedSpawn([{ stdout: "2026-10-17T12:00:00.5+05:30\n" }]);
    assert.deepEqual(await createDockerCleanupCli(ok.spawn).daemonTime(), new Date("2026-10-17T06:30:00.500Z"));
    assert.deepEqual(ok.calls[0].args, ["info", "--format", "{{.SystemTime}}"]);

    const bad = scriptedSpawn([{ stdout: "<no value>\n" }]);
    await assert.rejects(createDockerCleanupCli(bad.spawn).daemonTime(), /Unexpected Docker system time/);
  });

  it("force-removes by full id and rejects when docker rm fails", async () => {
    const { spawn, calls } = scriptedSpawn([{ exitCode: 0 }, { exitCode: 1, stderr: "No such container" }]);
    const cli = createDockerCleanupCli(spawn);
    await cli.remove(id);
    assert.deepEqual(calls[0].args, ["rm", "--force", id]);
    await assert.rejects(cli.remove(id), /No such container/);
  });

  it("rejects when the docker executable cannot be started", async () => {
    const spawn: SpawnFn = () => {
      const child = new FakeChild();
      setImmediate(() => child.emit("error", new Error("spawn docker ENOENT")));
      return child as unknown as ChildProcess;
    };
    await assert.rejects(createDockerCleanupCli(spawn).daemonTime(), /ENOENT/);
  });
});
