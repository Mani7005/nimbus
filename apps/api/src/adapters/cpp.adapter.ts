import fs from "fs/promises";
import path from "path";
import os from "os";
import { executeCommand } from "../runtime/docker.js";

export async function executeCpp(code: string) {
  // Create temporary directory
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "nimbus-")
  );

  const cppFile = path.join(tempDir, "main.cpp");

  await fs.writeFile(cppFile, code);

  console.log("📁 Temp Directory:", tempDir);

  const dockerCommand = `docker run --rm \
--memory=128m \
--cpus=1 \
--network=none \
-v "${tempDir}:/workspace" \
-w /workspace \
gcc:14 \
bash -c "g++ main.cpp -o main && ./main"`;

  try {
    const { stdout, stderr } = await executeCommand(dockerCommand);

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error: any) {

  if (error.killed || error.signal === "SIGTERM") {
    return {
      stdout: "",
      stderr: "Execution Timed Out",
    };
  }

  return {
    stdout: "",
    stderr: (error.stderr || error.message).trim(),
  };
} finally {
    // Clean up temporary directory
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
    });
  }
}