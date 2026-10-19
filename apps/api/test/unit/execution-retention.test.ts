// Mocked: the database is a fake that records the SQL it receives. Real deletions are covered by
// test/integration/execution-retention.integration.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FINISHED_EXECUTION_STATUSES,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES_PER_SWEEP,
  describeRetention,
  isRetentionEnabled,
  pruneExecutionHistory,
  type RetentionStore,
} from "../../src/services/execution-retention.js";

function recordingStore(deleted: number[] = []) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const store: RetentionStore = {
    async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      queries.push({ sql: strings.join("$?").replace(/\s+/g, " ").trim(), values });
      return deleted.shift() ?? 0;
    },
  };
  return { store, queries };
}

describe("pruneExecutionHistory", () => {
  it("runs no query when retention is disabled", async () => {
    const { store, queries } = recordingStore();
    assert.deepEqual(await pruneExecutionHistory(store, { maxPerUser: 0, maxTotal: 0 }), { deletedPerUser: 0, deletedTotal: 0 });
    assert.equal(queries.length, 0);
  });

  it("applies the per-user limit, then the total limit, and reports both counts", async () => {
    const { store, queries } = recordingStore([4, 7]);
    const summary = await pruneExecutionHistory(store, { maxPerUser: 50, maxTotal: 1000 }, { batchSize: 200 });

    assert.deepEqual(summary, { deletedPerUser: 4, deletedTotal: 7 });
    assert.equal(queries.length, 2);
    assert.match(queries[0].sql, /PARTITION BY "userId" ORDER BY "createdAt" DESC, id DESC/);
    assert.deepEqual(queries[0].values, [50, 200]);
    assert.match(queries[1].sql, /ORDER BY "createdAt" DESC, id DESC OFFSET \$\? LIMIT \$\?/);
    assert.deepEqual(queries[1].values, [1000, 200]);
  });

  it("runs only the configured limit", async () => {
    const perUserOnly = recordingStore();
    await pruneExecutionHistory(perUserOnly.store, { maxPerUser: 10, maxTotal: 0 });
    assert.equal(perUserOnly.queries.length, 1);
    assert.match(perUserOnly.queries[0].sql, /PARTITION BY "userId"/);
    assert.deepEqual(perUserOnly.queries[0].values, [10, RETENTION_BATCH_SIZE]);

    const totalOnly = recordingStore();
    await pruneExecutionHistory(totalOnly.store, { maxPerUser: 0, maxTotal: 100 });
    assert.equal(totalOnly.queries.length, 1);
    assert.match(totalOnly.queries[0].sql, /OFFSET/);
  });

  it("repeats full batches until one comes back short, so a backlog is cleared in one sweep", async () => {
    // Per-user: 3 + 3 + 1 (short, stop). Total: 3 + 0 (short, stop).
    const { store, queries } = recordingStore([3, 3, 1, 3, 0]);
    const summary = await pruneExecutionHistory(store, { maxPerUser: 5, maxTotal: 10 }, { batchSize: 3 });
    assert.deepEqual(summary, { deletedPerUser: 7, deletedTotal: 3 });
    assert.equal(queries.length, 5);
  });

  it("stops after the batch cap even if every batch is full, leaving the rest to the next sweep", async () => {
    const { store, queries } = recordingStore(Array(20).fill(2));
    const summary = await pruneExecutionHistory(store, { maxPerUser: 1, maxTotal: 0 }, { batchSize: 2, maxBatches: 4 });
    assert.deepEqual(summary, { deletedPerUser: 8, deletedTotal: 0 });
    assert.equal(queries.length, 4);
  });

  it("defaults to bounded batches with a bounded number per sweep", async () => {
    assert.equal(RETENTION_BATCH_SIZE, 1000);
    assert.equal(RETENTION_MAX_BATCHES_PER_SWEEP, 50);
  });

  it("only ever selects and deletes finished executions, passing limits as parameters", async () => {
    const { store, queries } = recordingStore();
    await pruneExecutionHistory(store, { maxPerUser: 1, maxTotal: 1 });
    assert.deepEqual(FINISHED_EXECUTION_STATUSES, ["COMPLETED", "FAILED", "TIMEOUT"]);
    for (const { sql } of queries) {
      assert.match(sql, /^DELETE FROM "Execution" WHERE status IN \('COMPLETED', 'FAILED', 'TIMEOUT'\) AND id IN \(/);
      assert.equal(sql.match(/status IN \('COMPLETED', 'FAILED', 'TIMEOUT'\)/g)?.length, 2, "the subquery and the DELETE both filter by status");
      assert.doesNotMatch(sql, /PENDING|RUNNING/);
    }
  });
});

describe("retention configuration", () => {
  it("is enabled when either limit is positive", () => {
    assert.equal(isRetentionEnabled({ maxPerUser: 0, maxTotal: 0 }), false);
    assert.equal(isRetentionEnabled({ maxPerUser: 5, maxTotal: 0 }), true);
    assert.equal(isRetentionEnabled({ maxPerUser: 0, maxTotal: 5 }), true);
  });

  it("describes the effective limits for the worker log", () => {
    assert.match(describeRetention({ maxPerUser: 0, maxTotal: 0 }), /disabled/);
    assert.equal(
      describeRetention({ maxPerUser: 50, maxTotal: 1000 }),
      "Execution history retention: keeping the newest 50 finished executions per user, 1000 in total",
    );
    assert.match(describeRetention({ maxPerUser: 0, maxTotal: 1000 }), /unlimited finished executions per user, 1000 in total/);
  });
});
