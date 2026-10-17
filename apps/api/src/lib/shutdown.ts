export const CLEAN_SHUTDOWN_MESSAGE = "Worker shut down cleanly";

// Operator-only log, so non-Error rejections are shown as they are rather than replaced by a generic message.
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

/**
 * Runs every step in order. A failed step is logged and the remaining steps still run, so other resources are still
 * released. Logs "<label> shut down cleanly" and returns true only when every step succeeded. Never rejects.
 */
export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  logger: Pick<Console, "log" | "error"> = console,
  label = "Worker",
): Promise<boolean> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failed.push(step.name);
      logger.error(`${label} shutdown step "${step.name}" failed: ${describeFailure(error)}`);
    }
  }

  if (failed.length > 0) {
    logger.error(`${label} shutdown incomplete: ${failed.length} of ${steps.length} steps failed (${failed.join(", ")})`);
    return false;
  }
  logger.log(`${label} shut down cleanly`);
  return true;
}

export type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";

/**
 * Signals that start a graceful shutdown on this platform:
 * - SIGINT: Ctrl+C, on every platform.
 * - SIGTERM: stop requests on Linux/macOS (docker stop, systemd, Kubernetes). Node can listen for it on Windows, but
 *   Windows never delivers it: there, stopping a process from outside terminates it without running any handler.
 * - SIGHUP: terminal hangup on Linux/macOS. On Windows Node raises it when the console window is closed, and Windows
 *   then terminates the process about 10 seconds later regardless, so shutdown there is best effort.
 * - SIGBREAK: Ctrl+Break, Windows only.
 */
export function shutdownSignals(platform: NodeJS.Platform = process.platform): ShutdownSignal[] {
  const signals: ShutdownSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  if (platform === "win32") signals.push("SIGBREAK");
  return signals;
}

export interface SignalShutdownOptions {
  /** Used in log lines, e.g. "worker" or "API". */
  name: string;
  /** Resolves true when every step succeeded. */
  shutdown: () => Promise<boolean>;
  /** Hard deadline: if shutdown has not finished by then, the process exits with code 1. */
  timeoutMs: number;
  signals?: readonly ShutdownSignal[];
  logger?: Pick<Console, "log" | "warn" | "error">;
  target?: { on(signal: ShutdownSignal, listener: () => void): unknown };
  exit?: (code: number) => void;
}

/**
 * Runs `shutdown` once on the first shutdown signal, then exits: 0 when it succeeded, 1 when a step failed or the
 * deadline passed. Later signals are logged and ignored, so cleanup never runs twice. The listeners stay registered
 * on purpose: when run through tsx, a signal arriving with no listener left makes tsx exit the process immediately.
 */
export function exitOnShutdownSignal(options: SignalShutdownOptions): void {
  const {
    name,
    shutdown,
    timeoutMs,
    signals = shutdownSignals(),
    logger = console,
    target = process,
    exit = (code: number) => process.exit(code),
  } = options;
  let started = false;
  let exited = false;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const onSignal = (signal: ShutdownSignal) => {
    if (started) {
      logger.warn(`${signal} received, ${name} shutdown already in progress`);
      return;
    }
    started = true;
    logger.log(`${signal} received, shutting down ${name}`);

    const deadline = setTimeout(() => {
      logger.error(`${name} shutdown did not finish within ${timeoutMs}ms; exiting`);
      exitOnce(1);
    }, timeoutMs);

    shutdown()
      .catch((error: unknown) => {
        logger.error(`${name} shutdown failed: ${describeFailure(error)}`);
        return false;
      })
      .then((clean) => {
        clearTimeout(deadline);
        exitOnce(clean ? 0 : 1);
      });
  };

  for (const signal of signals) target.on(signal, () => onSignal(signal));
}
