import { getErrorMessage } from "../utils/errors.js";

export interface PeriodicTask {
  /** Prevents further runs and waits for a run in progress to finish. */
  stop(): Promise<void>;
}

/** Runs the task now and then intervalMs after each run finishes, so runs never overlap. Task errors are logged. */
export function startPeriodicTask(
  name: string,
  task: () => Promise<unknown>,
  intervalMs: number,
  logger: Pick<Console, "error"> = console,
): PeriodicTask {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();

  const run = () => {
    current = (async () => {
      try {
        await task();
      } catch (error) {
        logger.error(`${name} failed: ${getErrorMessage(error)}`);
      }
      if (!stopped) {
        timer = setTimeout(run, intervalMs);
        timer.unref();
      }
    })();
  };

  run();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
