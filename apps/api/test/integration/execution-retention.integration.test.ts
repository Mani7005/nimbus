// REAL Postgres: skipped unless NIMBUS_POSTGRES_INTEGRATION=1. Uses the server in DATABASE_URL, but never its
// database: it creates a throwaway database (nimbus_it_<random>), applies the schema with `prisma db push`, and
// drops it afterwards. Proves which executions the history retention deletes and which it never touches.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { env } from "../../src/config/env.js";
import { pruneExecutionHistory } from "../../src/services/execution-retention.js";

const enabled = process.env.NIMBUS_POSTGRES_INTEGRATION === "1";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describe("pruneExecutionHistory with real Postgres", { skip: enabled ? false : "set NIMBUS_POSTGRES_INTEGRATION=1 to run", timeout: 120000 }, () => {
  const database = `nimbus_it_${randomBytes(6).toString("hex")}`;
  const admin = new PrismaClient({ datasourceUrl: withDatabase(env.DATABASE_URL, "postgres") });
  const testUrl = withDatabase(env.DATABASE_URL, database);
  let db: PrismaClient;

  before(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "ignore",
    });
    db = new PrismaClient({ datasourceUrl: testUrl });
  });

  after(async () => {
    await db?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.$disconnect();
  });

  beforeEach(async () => {
    await db.execution.deleteMany();
    await db.user.deleteMany();
  });

  const newUser = (name: string) => db.user.create({ data: { email: `${name}-${randomBytes(4).toString("hex")}@example.com`, password: "x" } });
  const T0 = Date.UTC(2026, 0, 1);

  /** Creates executions with the given statuses, oldest first, one minute apart starting at minute `from`. */
  async function seed(userId: string, statuses: string[], from = 0) {
    const ids: string[] = [];
    for (const [i, status] of statuses.entries()) {
      const row = await db.execution.create({
        data: { userId, language: "cpp", code: `// ${i}`, input: "", status, output: status === "PENDING" ? null : "out", createdAt: new Date(T0 + (from + i) * 60_000) },
      });
      ids.push(row.id);
    }
    return ids;
  }

  const remaining = async (userId?: string) =>
    (await db.execution.findMany({ where: userId ? { userId } : {}, orderBy: { createdAt: "asc" }, select: { id: true } })).map((r) => r.id);

  it("keeps the newest finished executions per user and never deletes unfinished ones", async () => {
    const [a, b] = await Promise.all([newUser("a"), newUser("b")]);
    // a: 3 old unfinished, then 5 finished of mixed final statuses.
    const aIds = await seed(a.id, ["PENDING", "RUNNING", "PENDING", "COMPLETED", "FAILED", "TIMEOUT", "COMPLETED", "FAILED"]);
    const bIds = await seed(b.id, ["COMPLETED", "COMPLETED"]);

    const summary = await pruneExecutionHistory(db, { maxPerUser: 2, maxTotal: 0 });

    assert.deepEqual(summary, { deletedPerUser: 3, deletedTotal: 0 });
    assert.deepEqual(await remaining(a.id), [aIds[0], aIds[1], aIds[2], aIds[6], aIds[7]], "unfinished rows stay; only the 2 newest finished stay");
    assert.deepEqual(await remaining(b.id), bIds, "another user's history within the limit is untouched");
  });

  it("caps finished executions across all users, oldest first", async () => {
    const [a, b] = await Promise.all([newUser("a"), newUser("b")]);
    const aIds = await seed(a.id, ["COMPLETED", "COMPLETED", "RUNNING"], 0); // minutes 0, 1, 2
    const bIds = await seed(b.id, ["FAILED", "COMPLETED"], 10); // minutes 10, 11

    const summary = await pruneExecutionHistory(db, { maxPerUser: 0, maxTotal: 3 });

    assert.deepEqual(summary, { deletedPerUser: 0, deletedTotal: 1 });
    assert.deepEqual(await remaining(), [aIds[1], aIds[2], bIds[0], bIds[1]]);
  });

  it("breaks createdAt ties by id so the kept set is deterministic", async () => {
    const user = await newUser("tie");
    const at = new Date(T0);
    const rows = await Promise.all(
      Array.from({ length: 4 }, (_, i) => db.execution.create({ data: { userId: user.id, language: "java", code: `${i}`, status: "COMPLETED", createdAt: at } })),
    );
    await pruneExecutionHistory(db, { maxPerUser: 2, maxTotal: 0 });
    const kept = rows.map((r) => r.id).sort().slice(-2);
    assert.deepEqual((await remaining(user.id)).sort(), kept);
  });

  it("clears a per-user backlog larger than one batch in a single sweep, keeping each user's newest", async () => {
    const [a, b] = await Promise.all([newUser("batch-a"), newUser("batch-b")]);
    const aIds = await seed(a.id, Array.from({ length: 11 }, () => "COMPLETED"), 0);
    const bIds = await seed(b.id, Array.from({ length: 6 }, () => "FAILED"), 100);

    // 10 + 5 over the limit, deleted in batches of 4 + 4 + 4 + 3.
    assert.deepEqual(await pruneExecutionHistory(db, { maxPerUser: 1, maxTotal: 0 }, { batchSize: 4 }), { deletedPerUser: 15, deletedTotal: 0 });
    assert.deepEqual(await remaining(a.id), [aIds[10]]);
    assert.deepEqual(await remaining(b.id), [bIds[5]]);
  });

  it("clears a total backlog larger than one batch in a single sweep, keeping the newest overall", async () => {
    const [a, b] = await Promise.all([newUser("total-a"), newUser("total-b")]);
    await seed(a.id, Array.from({ length: 6 }, () => "COMPLETED"), 0);
    const bIds = await seed(b.id, Array.from({ length: 5 }, () => "TIMEOUT"), 100);

    // 11 finished, 10 over the limit, deleted in batches of 4 + 4 + 2.
    assert.deepEqual(await pruneExecutionHistory(db, { maxPerUser: 0, maxTotal: 1 }, { batchSize: 4 }), { deletedPerUser: 0, deletedTotal: 10 });
    assert.deepEqual(await remaining(), [bIds[4]]);
  });

  it("stops at the batch cap and continues on the next sweep", async () => {
    const user = await newUser("capped");
    const ids = await seed(user.id, Array.from({ length: 9 }, () => "COMPLETED"));

    assert.deepEqual(await pruneExecutionHistory(db, { maxPerUser: 1, maxTotal: 0 }, { batchSize: 2, maxBatches: 2 }), { deletedPerUser: 4, deletedTotal: 0 });
    assert.equal((await remaining(user.id)).length, 5);
    assert.deepEqual(await pruneExecutionHistory(db, { maxPerUser: 1, maxTotal: 0 }, { batchSize: 2, maxBatches: 2 }), { deletedPerUser: 4, deletedTotal: 0 });
    assert.deepEqual(await pruneExecutionHistory(db, { maxPerUser: 1, maxTotal: 0 }, { batchSize: 2, maxBatches: 2 }), { deletedPerUser: 0, deletedTotal: 0 });
    assert.deepEqual(await remaining(user.id), [ids[8]], "only the newest is kept");
  });

  it("stays correct when sweeps overlap each other and executions finish concurrently", async () => {
    const [a, b] = await Promise.all([newUser("busy-a"), newUser("busy-b")]);
    await seed(a.id, Array.from({ length: 40 }, (_, i) => (i % 2 ? "COMPLETED" : "FAILED")), 0);
    const runningIds = await seed(a.id, Array.from({ length: 10 }, () => "RUNNING"), 40);
    const pendingIds = await seed(b.id, Array.from({ length: 5 }, () => "PENDING"), 50);
    await seed(b.id, Array.from({ length: 30 }, () => "TIMEOUT"), 55);

    // Three overlapping sweeps (as with several workers) while half of the RUNNING executions finish, using the same
    // status-conditioned update the processor uses.
    const finishing = runningIds.slice(0, 5);
    const results = await Promise.allSettled([
      pruneExecutionHistory(db, { maxPerUser: 3, maxTotal: 4 }, { batchSize: 5 }),
      pruneExecutionHistory(db, { maxPerUser: 3, maxTotal: 4 }, { batchSize: 5 }),
      ...finishing.map((id) => db.execution.updateMany({ where: { id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "COMPLETED", output: "done" } })),
      pruneExecutionHistory(db, { maxPerUser: 3, maxTotal: 4 }, { batchSize: 5 }),
    ]);
    for (const result of results) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");

    // A final sweep converges; then every limit holds and no unfinished execution was touched.
    await pruneExecutionHistory(db, { maxPerUser: 3, maxTotal: 4 });
    const rows = await db.execution.findMany({ select: { id: true, userId: true, status: true } });
    const finished = rows.filter((r) => ["COMPLETED", "FAILED", "TIMEOUT"].includes(r.status));
    assert.ok(finished.length <= 4, `total finished ${finished.length}`);
    for (const user of [a, b]) assert.ok(finished.filter((r) => r.userId === user.id).length <= 3);
    const stillUnfinished = [...runningIds.slice(5), ...pendingIds];
    for (const id of stillUnfinished) assert.ok(rows.some((r) => r.id === id), `unfinished execution ${id} must survive`);
    assert.equal(rows.filter((r) => r.status === "RUNNING").length, 5);
    assert.equal(rows.filter((r) => r.status === "PENDING").length, 5);
  });

  it("is a no-op within the limits", async () => {
    const user = await newUser("small");
    const ids = await seed(user.id, ["COMPLETED", "FAILED"]);
    assert.deepEqual(await pruneExecutionHistory(db, { maxPerUser: 50, maxTotal: 1000 }), { deletedPerUser: 0, deletedTotal: 0 });
    assert.deepEqual(await remaining(user.id), ids);
  });
});
