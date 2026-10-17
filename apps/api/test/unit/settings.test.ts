import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readEnumSetting, readSecretSetting, readUrlSetting } from "../../src/config/settings.js";

describe("readEnumSetting", () => {
  it("returns the fallback when unset and the value when allowed", () => {
    assert.equal(readEnumSetting("MODE", ["a", "b"], "a", {}), "a");
    assert.equal(readEnumSetting("MODE", ["a", "b"], "a", { MODE: " b " }), "b");
  });

  it("rejects values outside the allowed set", () => {
    assert.throws(() => readEnumSetting("MODE", ["a", "b"], "a", { MODE: "c" }), /MODE must be one of a, b, got "c"/);
  });
});

describe("readSecretSetting", () => {
  it("requires a value of the minimum length and reports only the length", () => {
    assert.equal(readSecretSetting("KEY", 4, { KEY: "abcd" }), "abcd");
    assert.throws(() => readSecretSetting("KEY", 4, {}), /^Error: KEY is required$/);
    assert.throws(() => readSecretSetting("KEY", 4, { KEY: "abc" }), (error: Error) => {
      assert.equal(error.message, "KEY must be at least 4 characters, got 3");
      return true;
    });
  });
});

describe("readUrlSetting", () => {
  it("accepts allowed protocols, including credentials and special characters", () => {
    const url = "postgresql://user:p%40ss@localhost:5432/db?schema=public";
    assert.equal(readUrlSetting("DB", ["postgresql:"], { DB: url }), url);
  });

  it("never includes the value in errors", () => {
    for (const value of ["http://user:secret@host", "secret garbage"]) {
      assert.throws(() => readUrlSetting("DB", ["postgresql:"], { DB: value }), (error: Error) => {
        assert.ok(!error.message.includes("secret"), error.message);
        return true;
      });
    }
  });
});
