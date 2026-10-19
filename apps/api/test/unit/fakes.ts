import type { ChildProcess, SpawnOptions } from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ContainerRunResult, RunnerDeps } from "../../src/runtime/docker.js";

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];
  closed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    setImmediate(() => this.close(null, "SIGKILL"));
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

export interface FakeDocker {
  deps: RunnerDeps;
  child: FakeChild;
  spawnCalls: SpawnCall[];
  removed: string[];
}

/**
 * Mocked Docker CLI: `onSpawn` scripts the `docker run` process, `onRemove` simulates what `docker rm -f`
 * does to it. No real process or container is involved.
 */
export function createFakeDocker({
  onSpawn = () => undefined,
  onRemove = (child: FakeChild) => setImmediate(() => child.close(137)),
  containerId = "abc123",
}: {
  onSpawn?: (child: FakeChild) => void;
  onRemove?: (child: FakeChild) => void;
  containerId?: string;
} = {}): FakeDocker {
  const child = new FakeChild();
  const fake: FakeDocker = {
    child,
    spawnCalls: [],
    removed: [],
    deps: {
      spawn: (command, args, options) => {
        fake.spawnCalls.push({ command, args, options });
        setImmediate(() => onSpawn(child));
        return child as unknown as ChildProcess;
      },
      removeContainer: async (name) => {
        fake.removed.push(name);
        onRemove(child);
      },
      readContainerId: async () => containerId,
    },
  };
  return fake;
}

export function runResult(fields: Partial<ContainerRunResult> = {}): ContainerRunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
    terminationReason: null,
    containerCreated: true,
    spawnError: null,
    ...fields,
  };
}
