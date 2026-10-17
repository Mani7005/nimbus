import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "child_process";
import fs from "fs/promises";

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface SandboxOptions {
  image: string;
  memory: string;
  cpus: string;
}

export const DEFAULT_SANDBOX: SandboxOptions = { image: "gcc:14", memory: "128m", cpus: "1" };

export interface DockerRunSpec {
  containerName: string;
  /** Host file Docker writes the container id to once the container exists. Must not already exist. */
  cidFile: string;
  workspaceDir: string;
  command: readonly string[];
  sandbox?: SandboxOptions;
}

export interface RunContainerOptions extends DockerRunSpec {
  timeoutMs: number;
  /** Per-stream cap; bytes beyond it are discarded while the stream keeps draining. */
  maxOutputBytes: number;
  terminateOnOutputLimit: boolean;
  /** How long to wait for `docker rm -f` to end the CLI before killing the CLI directly. */
  killGraceMs?: number;
}

export type TerminationReason = "timeout" | "output_limit";

export interface ContainerRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  terminationReason: TerminationReason | null;
  /** False when Docker never created the container, i.e. the failure was not caused by submitted code. */
  containerCreated: boolean;
  spawnError: Error | null;
}

export interface RunnerDeps {
  spawn: SpawnFn;
  removeContainer: (containerName: string) => Promise<void>;
  readContainerId: (cidFile: string) => Promise<string>;
}

const DEFAULT_KILL_GRACE_MS = 5000;
const REMOVE_TIMEOUT_MS = 10000;

const spawnProcess: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

export function buildDockerRunArgs({ containerName, cidFile, workspaceDir, command, sandbox = DEFAULT_SANDBOX }: DockerRunSpec): string[] {
  return [
    "run",
    "--rm",
    "--name", containerName,
    "--cidfile", cidFile,
    "--pull=never",
    "--network=none",
    `--memory=${sandbox.memory}`,
    `--cpus=${sandbox.cpus}`,
    "-v", `${workspaceDir}:/workspace`,
    "-w", "/workspace",
    sandbox.image,
    ...command,
  ];
}

/** Force-removes (and thereby kills) a container. Never rejects: a missing container is the expected case. */
export function removeContainer(containerName: string, spawn: SpawnFn = spawnProcess): Promise<void> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("docker", ["rm", "-f", containerName], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, REMOVE_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", done);
    child.on("close", done);
  });
}

async function readContainerId(cidFile: string): Promise<string> {
  try {
    return (await fs.readFile(cidFile, "utf8")).trim();
  } catch {
    return "";
  }
}

export const defaultRunnerDeps: RunnerDeps = {
  spawn: spawnProcess,
  removeContainer: (containerName) => removeContainer(containerName),
  readContainerId,
};

class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  /** Returns false once the limit has been exceeded. */
  append(chunk: Buffer): boolean {
    const remaining = this.limit - this.size;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return true;
    }

    if (remaining > 0) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
    }
    this.truncated = true;
    return false;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Runs one sandboxed container through the Docker CLI without a shell. Always resolves; on timeout or
 * output overflow the named container is force-removed, and removed again after the CLI exits in case
 * the daemon created it after the first removal.
 */
export function runContainer(options: RunContainerOptions, deps: RunnerDeps = defaultRunnerDeps): Promise<ContainerRunResult> {
  const { containerName, cidFile, timeoutMs, maxOutputBytes, terminateOnOutputLimit, killGraceMs = DEFAULT_KILL_GRACE_MS } = options;

  return new Promise((resolve) => {
    const stdout = new CappedBuffer(maxOutputBytes);
    const stderr = new CappedBuffer(maxOutputBytes);
    let terminationReason: TerminationReason | null = null;
    let removal: Promise<void> = Promise.resolve();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = async (exitCode: number | null, signal: NodeJS.Signals | null, spawnError: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);

      if (terminationReason || spawnError) {
        await removal;
        await deps.removeContainer(containerName);
      }

      resolve({
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        outputTruncated: stdout.truncated || stderr.truncated,
        terminationReason,
        containerCreated: (await deps.readContainerId(cidFile)) !== "",
        spawnError,
      });
    };

    let child: ChildProcess;
    try {
      child = deps.spawn("docker", buildDockerRunArgs(options), { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      void finish(null, null, error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const terminate = (reason: TerminationReason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      clearTimeout(timeoutTimer);
      removal = deps.removeContainer(containerName);
      graceTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    };

    const capture = (buffer: CappedBuffer) => (chunk: Buffer) => {
      if (!buffer.append(chunk) && terminateOnOutputLimit) terminate("output_limit");
    };

    child.stdout?.on("data", capture(stdout));
    child.stderr?.on("data", capture(stderr));
    child.on("error", (error) => void finish(null, null, error));
    child.on("close", (code, signal) => void finish(code, signal, null));
    timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
  });
}
