import { useCallback, useEffect, useRef } from "react";
import { executeCode, getExecution } from "../services/execution";

const FINAL_EXECUTION_STATUSES = new Set(["COMPLETED", "FAILED", "TIMEOUT"]);

interface UseExecutionRunnerOptions {
  onComplete: (output: string) => Promise<void> | void;
  onOutputChange: (output: string) => void;
}

export function useExecutionRunner({ onComplete, onOutputChange }: UseExecutionRunnerOptions) {
  const pollingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = useCallback(() => {
    if (pollingTimer.current) {
      clearInterval(pollingTimer.current);
      pollingTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  return useCallback(async (language: string, code: string, input: string) => {
    try {
      onOutputChange("Running...");
      const result = await executeCode(language, code, input);
      const executionId = result.execution.id;
      stopPolling();
      pollingTimer.current = setInterval(() => {
        void (async () => {
          try {
            const { execution } = await getExecution(executionId);
            if (FINAL_EXECUTION_STATUSES.has(execution.status)) {
              stopPolling();
              onOutputChange(execution.output || "No Output");
              await onComplete(execution.output || "No Output");
            }
          } catch (error) {
            stopPolling();
            console.error(error);
            onOutputChange("Failed to fetch execution.");
          }
        })();
      }, 1000);
    } catch (error) {
      console.error(error);
      onOutputChange("Execution Failed");
    }
  }, [onComplete, onOutputChange, stopPolling]);
}
