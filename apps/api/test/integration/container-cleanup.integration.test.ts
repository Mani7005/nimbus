// REAL Docker: skipped unless NIMBUS_DOCKER_INTEGRATION=1. Requires a pre-pulled gcc:14 image.
// Starts idle containers and runs the cleanup against them. The listing is restricted to the containers this test
// created, so execution containers belonging to a running worker are never touched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { cleanupLeakedContainers, createDockerCleanupCli, type ContainerCleanupDocker } from "../../src/runtime/container-cleanup.js";

const enabled = process.env.NIMBUS_DOCKER_INTEGRATION === "1";
const logger = { log: () => undefined, warn: () => undefined, error: () => undefined };

// The label lets the leak checks in cpp-docker.integration.test.ts, which may run in parallel, ignore these.
function startIdleContainer(name: string): void {
  execFileSync("docker", ["run", "-d", "--rm", "--pull=never", "--label", "nimbus.test=cleanup", "--name", name, "gcc:14", "sleep", "120"], {
    stdio: "ignore",
  });
}

function exists(name: string): boolean {
  return execFileSync("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim() === name;
}

function forceRemove(names: string[]): void {
  try {
    execFileSync("docker", ["rm", "-f", ...names], { stdio: "ignore" });
  } catch {
    // Already removed.
  }
}

function restrictedTo(names: string[]): ContainerCleanupDocker {
  const cli = createDockerCleanupCli();
  return {
    ...cli,
    listExecutionContainers: async () => (await cli.listExecutionContainers()).filter((container) => names.includes(container.name)),
  };
}

describe("cleanupLeakedContainers with real Docker", { skip: enabled ? false : "set NIMBUS_DOCKER_INTEGRATION=1 to run", timeout: 120000 }, () => {
  it("removes a stale execution container and leaves a similarly named container alone", async () => {
    const target = `nimbus-run-${randomUUID()}`;
    const decoy = `nimbus-cleanup-decoy-${randomUUID()}`;
    try {
      startIdleContainer(target);
      startIdleContainer(decoy);
      const docker = restrictedTo([target, decoy]);

      const dryRun = await cleanupLeakedContainers({ docker, mode: "dry-run", minAgeMs: 0, logger });
      assert.deepEqual({ found: dryRun.found, stale: dryRun.stale, removed: dryRun.removed }, { found: 1, stale: 1, removed: 0 });
      assert.ok(exists(target), "dry run must not remove anything");

      const summary = await cleanupLeakedContainers({ docker, mode: "remove", minAgeMs: 0, logger });
      assert.deepEqual(summary, { found: 1, stale: 1, removed: 1, errors: 0, aborted: false });
      assert.equal(exists(target), false);
      assert.equal(exists(decoy), true);
    } finally {
      forceRemove([target, decoy]);
    }
  });

  it("leaves an execution container younger than the minimum age running", async () => {
    const young = `nimbus-compile-${randomUUID()}`;
    try {
      startIdleContainer(young);
      const summary = await cleanupLeakedContainers({ docker: restrictedTo([young]), mode: "remove", minAgeMs: 10 * 60_000, logger });
      assert.deepEqual({ found: summary.found, stale: summary.stale, removed: summary.removed }, { found: 1, stale: 0, removed: 0 });
      assert.ok(exists(young));
    } finally {
      forceRemove([young]);
    }
  });
});
