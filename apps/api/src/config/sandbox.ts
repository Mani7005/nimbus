import { HARD_TIMEOUT_GRACE_MS } from "../runtime/docker.js";
import { env } from "./env.js";
import { readEnumSetting, readIntSetting, type Source } from "./settings.js";

const MIB = 1024 * 1024;

export type ContainerCleanupMode = "off" | "dry-run" | "remove";

const CLEANUP_MODES: readonly ContainerCleanupMode[] = ["off", "dry-run", "remove"];

/** Defaults to dry-run: stale containers are only logged until removal is switched on explicitly. */
export function readCleanupMode(source: Source = process.env): ContainerCleanupMode {
  return readEnumSetting("EXECUTION_CONTAINER_CLEANUP", CLEANUP_MODES, "dry-run", source);
}

/**
 * The youngest age at which an execution container is certainly leaked: the in-container timeout ends every
 * legitimate container within its stage timeout plus the grace period, and a minute covers container start-up.
 */
export function minimumCleanupAgeMs(compileTimeoutMs: number, runTimeoutMs: number): number {
  return Math.max(compileTimeoutMs, runTimeoutMs) + HARD_TIMEOUT_GRACE_MS + 60_000;
}

export const sandboxConfig = {
  pidsLimit: readIntSetting("EXECUTION_PIDS_LIMIT", 64, 16, 1024),
  compileMemoryMb: readIntSetting("EXECUTION_COMPILE_MEMORY_MB", 512, 128, 4096),
  runMemoryMb: readIntSetting("EXECUTION_RUN_MEMORY_MB", 256, 32, 4096),
  maxFileSizeBytes: readIntSetting("EXECUTION_MAX_FILE_SIZE_MB", 32, 1, 1024) * MIB,
};

const cleanupAgeFloorMs = minimumCleanupAgeMs(env.EXECUTION_COMPILE_TIMEOUT_MS, env.EXECUTION_RUN_TIMEOUT_MS);

export const containerCleanupConfig = {
  mode: readCleanupMode(),
  minAgeMs: readIntSetting(
    "EXECUTION_CONTAINER_CLEANUP_MIN_AGE_MS",
    Math.max(10 * 60_000, cleanupAgeFloorMs),
    cleanupAgeFloorMs,
    7 * 24 * 60 * 60_000,
  ),
};
