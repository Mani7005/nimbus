export type Source = Record<string, string | undefined>;

/** Every configuration problem found at startup, reported together. Never includes secret or URL values. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

function readRaw(name: string, source: Source): string | undefined {
  const raw = source[name]?.trim();
  return raw === "" ? undefined : raw;
}

/** Reads a whole-number setting; anything else, or a value outside [min, max], fails at startup. */
export function readIntSetting(name: string, fallback: number, min: number, max: number, source: Source = process.env): number {
  const raw = readRaw(name, source);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

export function readEnumSetting<T extends string>(name: string, allowed: readonly T[], fallback: T, source: Source = process.env): T {
  const raw = readRaw(name, source);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  return raw as T;
}

/** Required secret of at least minLength characters. Only its length is ever reported. */
export function readSecretSetting(name: string, minLength: number, source: Source = process.env): string {
  const raw = readRaw(name, source);
  if (raw === undefined) throw new Error(`${name} is required`);
  if (raw.length < minLength) throw new Error(`${name} must be at least ${minLength} characters, got ${raw.length}`);
  return raw;
}

/** Required URL with one of the given protocols (e.g. "redis:"). The value is never reported: it may hold a password. */
export function readUrlSetting(name: string, protocols: readonly string[], source: Source = process.env): string {
  const raw = readRaw(name, source);
  if (raw === undefined) throw new Error(`${name} is required`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${name} must use ${protocols.map((p) => `${p}//`).join(" or ")}`);
  return raw;
}
