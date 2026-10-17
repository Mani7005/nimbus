import { spawn as nodeSpawn } from "child_process";
import type { ContainerCleanupMode } from "../config/sandbox.js";
import { getErrorMessage } from "../utils/errors.js";
import type { SpawnFn } from "./docker.js";

/** Names executeCpp gives its containers. Never matches nimbus-postgres, nimbus-redis or anything else. */
export const EXECUTION_CONTAINER_NAME = /^nimbus-(compile|run)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const DOCKER_COMMAND_TIMEOUT_MS = 15000;
const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;
// Keeps the `docker inspect` command line well under the Windows limit.
const MAX_LISTED_CONTAINERS = 200;

export interface ContainerInfo {
  id: string;
  name: string;
  createdAt: Date;
  state: string;
}

export interface ContainerCleanupDocker {
  /** The Docker daemon's clock, so ages do not depend on the host clock (Docker Desktop's VM clock can drift). */
  daemonTime(): Promise<Date>;
  listExecutionContainers(): Promise<ContainerInfo[]>;
  remove(id: string): Promise<void>;
}

export interface ContainerCleanupOptions {
  docker: ContainerCleanupDocker;
  mode: ContainerCleanupMode;
  /** Only containers older than this are touched; it must exceed the longest legitimate container lifetime. */
  minAgeMs: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  maxRemovals?: number;
}

export interface ContainerCleanupSummary {
  found: number;
  stale: number;
  removed: number;
  errors: number;
  aborted: boolean;
}

/** Execution containers strictly older than minAgeMs by the daemon's clock. Unparseable dates are never selected. */
export function selectStaleContainers(containers: readonly ContainerInfo[], daemonNow: Date, minAgeMs: number): ContainerInfo[] {
  return containers.filter((container) => {
    const age = daemonNow.getTime() - container.createdAt.getTime();
    return EXECUTION_CONTAINER_NAME.test(container.name) && Number.isFinite(age) && age > minAgeMs;
  });
}

/** One-line result. Skipped counts stale containers left in place by a dry run or the removal limit. */
export function formatCleanupResult(mode: ContainerCleanupMode, summary: ContainerCleanupSummary): string {
  if (mode === "off") return "Container cleanup (off): disabled, Docker not queried";
  if (summary.aborted) return `Container cleanup (${mode}): aborted, could not query Docker; nothing removed`;
  const skipped = summary.stale - summary.removed - summary.errors;
  return `Container cleanup (${mode}): found ${summary.found}, stale ${summary.stale}, removed ${summary.removed}, skipped ${skipped}, errors ${summary.errors}`;
}

/**
 * Removes execution containers left running by a worker that died mid-run. Age is the only signal that a container
 * is not in use, so this is safe with several workers: every legitimate container ends within its stage timeout
 * (enforced inside the container), which minAgeMs must exceed. Every Docker failure removes nothing. Always logs one
 * result line. Never rejects.
 */
export async function cleanupLeakedContainers(options: ContainerCleanupOptions): Promise<ContainerCleanupSummary> {
  const { logger = console } = options;
  const summary = await sweepLeakedContainers(options, logger);
  const result = formatCleanupResult(options.mode, summary);
  if (summary.errors) logger.warn(result);
  else logger.log(result);
  return summary;
}

async function sweepLeakedContainers(
  options: ContainerCleanupOptions,
  logger: Pick<Console, "log" | "warn" | "error">,
): Promise<ContainerCleanupSummary> {
  const { docker, mode, minAgeMs, maxRemovals = 50 } = options;
  const summary: ContainerCleanupSummary = { found: 0, stale: 0, removed: 0, errors: 0, aborted: false };
  if (mode === "off") return summary;

  let stale: ContainerInfo[];
  try {
    // Read before listing, so a container's age is never overstated.
    const daemonNow = await docker.daemonTime();
    const containers = await docker.listExecutionContainers();
    summary.found = containers.filter((container) => EXECUTION_CONTAINER_NAME.test(container.name)).length;
    stale = selectStaleContainers(containers, daemonNow, minAgeMs);
  } catch (error) {
    logger.warn(`Container cleanup skipped, could not query Docker: ${getErrorMessage(error)}`);
    summary.errors++;
    summary.aborted = true;
    return summary;
  }

  summary.stale = stale.length;
  for (const container of stale.slice(0, maxRemovals)) {
    const description = `${container.name} (${container.state}, created ${container.createdAt.toISOString()})`;
    if (mode === "dry-run") {
      logger.log(`Dry run: would remove leaked execution container ${description}`);
      continue;
    }
    try {
      await docker.remove(container.id);
      summary.removed++;
      logger.warn(`Removed leaked execution container ${description}`);
    } catch (error) {
      summary.errors++;
      logger.error(`Could not remove leaked execution container ${description}: ${getErrorMessage(error)}`);
    }
  }
  return summary;
}

interface DockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the Docker CLI without a shell. Rejects only when it cannot be started or exceeds timeoutMs. */
export function runDockerCommand(
  args: readonly string[],
  spawn: SpawnFn = (command, commandArgs, options) => nodeSpawn(command, commandArgs, options),
  timeoutMs = DOCKER_COMMAND_TIMEOUT_MS,
): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) => (current.length < MAX_CLI_OUTPUT_BYTES ? current + chunk.toString("utf8") : current);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/** Parses `docker inspect` lines in INSPECT_FORMAT; malformed lines are dropped. */
export function parseInspectOutput(output: string): ContainerInfo[] {
  const containers: ContainerInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [id, name, created, state] = line.trim().split("|");
    if (!id || !CONTAINER_ID.test(id) || !name || !created || !state) continue;
    containers.push({ id, name: name.replace(/^\//, ""), createdAt: new Date(created), state });
  }
  return containers;
}

const INSPECT_FORMAT = "{{.Id}}|{{.Name}}|{{.Created}}|{{.State.Status}}";

function describeFailure(command: string, result: DockerCommandResult): Error {
  return new Error(`docker ${command} exited with code ${result.exitCode}: ${result.stderr.trim()}`);
}

export function createDockerCleanupCli(spawn?: SpawnFn): ContainerCleanupDocker {
  const run = (args: readonly string[]) => runDockerCommand(args, spawn);

  return {
    async daemonTime() {
      const result = await run(["info", "--format", "{{.SystemTime}}"]);
      if (result.exitCode !== 0) throw describeFailure("info", result);
      const time = new Date(result.stdout.trim());
      if (!Number.isFinite(time.getTime())) throw new Error(`Unexpected Docker system time: ${JSON.stringify(result.stdout.trim())}`);
      return time;
    },

    async listExecutionContainers() {
      // Docker's name filter is a loose match; selectStaleContainers applies the exact name pattern.
      const listed = await run(["ps", "--all", "--no-trunc", "--filter", "name=nimbus-", "--format", "{{.ID}}"]);
      if (listed.exitCode !== 0) throw describeFailure("ps", listed);
      const ids = listed.stdout
        .split(/\r?\n/)
        .map((id) => id.trim())
        .filter((id) => CONTAINER_ID.test(id))
        .slice(0, MAX_LISTED_CONTAINERS);
      if (ids.length === 0) return [];

      // A container removed since `docker ps` fails inspect for that id only; the others are still printed.
      const inspected = await run(["inspect", "--format", INSPECT_FORMAT, ...ids]);
      return parseInspectOutput(inspected.stdout);
    },

    async remove(id) {
      const result = await run(["rm", "--force", id]);
      if (result.exitCode !== 0) throw describeFailure("rm", result);
    },
  };
}
