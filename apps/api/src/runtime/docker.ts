import { spawn } from "child_process";

export function executeCommand(
  command: string,
  input = "",
  timeout = 15000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", () => {
      resolve({
        stdout,
        stderr,
      });
    });

    child.stdin.write(input);
    child.stdin.end();

    setTimeout(() => {
      child.kill();
      reject(new Error("Execution Timed Out"));
    }, timeout);
  });
}