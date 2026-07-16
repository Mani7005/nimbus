import { exec } from "child_process";
import { promisify } from "util";

export const executeCommand = (
  command: string,
  timeout = 15000
) => {
  return promisify(exec)(command, {
    timeout,
    maxBuffer: 1024 * 1024,
  });
};