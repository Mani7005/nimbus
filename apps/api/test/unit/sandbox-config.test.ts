import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minimumCleanupAgeMs, readCleanupMode } from "../../src/config/sandbox.js";
import { readIntSetting } from "../../src/config/settings.js";
import { HARD_TIMEOUT_GRACE_MS } from "../../src/runtime/docker.js";

describe("readIntSetting", () => {
  it("uses the fallback when the setting is unset or blank", () => {
    assert.equal(readIntSetting("LIMIT", 64, 16, 1024, {}), 64);
    assert.equal(readIntSetting("LIMIT", 64, 16, 1024, { LIMIT: "  " }), 64);
  });

  it("accepts whole numbers within range, including the bounds", () => {
    assert.equal(readIntSetting("LIMIT", 64, 16, 1024, { LIMIT: "16" }), 16);
    assert.equal(readIntSetting("LIMIT", 64, 16, 1024, { LIMIT: " 1024 " }), 1024);
  });

  it("rejects values that are not whole numbers", () => {
    for (const value of ["abc", "12.5", "-1", "1e3", "0x40", "64m"]) {
      assert.throws(() => readIntSetting("LIMIT", 64, 16, 1024, { LIMIT: value }), /LIMIT must be a whole number/, value);
    }
  });

  it("rejects values outside the range instead of clamping them", () => {
    assert.throws(() => readIntSetting("LIMIT", 64, 16, 1024, { LIMIT: "0" }), /between 16 and 1024, got 0/);
    assert.throws(() => readIntSetting("LIMIT", 64, 16, 1024, { LIMIT: "1025" }), /between 16 and 1024/);
  });
});

describe("readCleanupMode", () => {
  it("defaults to dry-run", () => {
    assert.equal(readCleanupMode({}), "dry-run");
  });

  it("accepts each supported mode", () => {
    for (const mode of ["off", "dry-run", "remove"]) assert.equal(readCleanupMode({ EXECUTION_CONTAINER_CLEANUP: mode }), mode);
  });

  it("rejects unknown modes", () => {
    assert.throws(() => readCleanupMode({ EXECUTION_CONTAINER_CLEANUP: "true" }), /must be one of off, dry-run, remove/);
  });
});

describe("minimumCleanupAgeMs", () => {
  it("exceeds the longest stage timeout plus the in-container grace period", () => {
    assert.equal(minimumCleanupAgeMs(30000, 10000), 30000 + HARD_TIMEOUT_GRACE_MS + 60000);
    assert.equal(minimumCleanupAgeMs(5000, 90000), 90000 + HARD_TIMEOUT_GRACE_MS + 60000);
  });
});
