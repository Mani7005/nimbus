import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startPeriodicTask } from "../../src/workers/periodic-task.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startPeriodicTask", () => {
  it("runs immediately and then repeatedly", async () => {
    let runs = 0;
    const task = startPeriodicTask("test", async () => void runs++, 10);
    assert.equal(runs, 1, "first run starts synchronously at startup");
    await sleep(60);
    await task.stop();
    assert.ok(runs >= 3, `expected repeated runs, got ${runs}`);
  });

  it("never overlaps runs", async () => {
    let active = 0;
    let maxActive = 0;
    const task = startPeriodicTask("test", async () => {
      maxActive = Math.max(maxActive, ++active);
      await sleep(15);
      active--;
    }, 1);
    await sleep(80);
    await task.stop();
    assert.equal(maxActive, 1);
  });

  it("stop waits for the run in progress and prevents further runs", async () => {
    let finished = false;
    let runs = 0;
    const task = startPeriodicTask("test", async () => {
      runs++;
      await sleep(30);
      finished = true;
    }, 1);
    await task.stop();
    assert.equal(finished, true);
    await sleep(30);
    assert.equal(runs, 1);
  });

  it("logs task errors and keeps running", async () => {
    const errors: string[] = [];
    let runs = 0;
    const task = startPeriodicTask("Reconciliation", async () => {
      runs++;
      throw new Error("boom");
    }, 5, { error: (message: string) => void errors.push(message) });
    await sleep(40);
    await task.stop();
    assert.ok(runs >= 2);
    assert.equal(errors[0], "Reconciliation failed: boom");
  });
});
