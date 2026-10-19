import { useCallback, useEffect, useState } from "react";
import { executeCode, getExecution } from "../services/execution";
import { ExecutionRunner } from "../services/execution-runner";

interface UseExecutionRunnerOptions {
  onComplete: (output: string) => Promise<void> | void;
  onOutputChange: (output: string) => void;
}

/** Runs one execution at a time; polling stops on unmount and whenever `cancel` is called (e.g. on logout). */
export function useExecutionRunner({ onComplete, onOutputChange }: UseExecutionRunnerOptions) {
  const [isRunning, setIsRunning] = useState(false);
  const [runner] = useState(
    () =>
      new ExecutionRunner(
        {
          submit: async (language, code, input) => (await executeCode(language, code, input)).execution,
          fetchExecution: async (id, signal) => (await getExecution(id, signal)).execution,
        },
        setIsRunning,
      ),
  );

  useEffect(() => () => runner.cancel(), [runner]);

  const run = useCallback(
    (language: string, code: string, input: string) => runner.run(language, code, input, { onOutput: onOutputChange, onComplete }),
    [runner, onComplete, onOutputChange],
  );
  const cancel = useCallback(() => runner.cancel(), [runner]);

  return { run, cancel, isRunning };
}
