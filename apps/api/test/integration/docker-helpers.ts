import { execFileSync } from "node:child_process";

// Matches only the per-execution containers named in executeCompiledProgram, not nimbus-postgres / nimbus-redis.
const EXECUTION_CONTAINER_NAME = /^nimbus-(compile|run)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Containers labelled nimbus.test are deliberate stand-ins started by container-cleanup.integration.test.ts.
export function leakedExecutionContainers(): string[] {
  const lines = execFileSync("docker", ["ps", "-a", "--format", '{{.Names}}|{{.Label "nimbus.test"}}'], { encoding: "utf8" });
  return lines
    .split(/\r?\n/)
    .map((line) => line.trim().split("|"))
    .filter(([name, testLabel]) => EXECUTION_CONTAINER_NAME.test(name) && !testLabel)
    .map(([name]) => name);
}
