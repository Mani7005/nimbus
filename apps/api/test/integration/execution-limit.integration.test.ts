// REAL Postgres: skipped unless NIMBUS_POSTGRES_INTEGRATION=1. Uses the server in DATABASE_URL, but never its
// database: it creates a throwaway database (nimbus_it_<random>), applies the schema with `prisma db push`, and
// drops it afterwards. Proves the advisory lock makes the unfinished-execution cap strict under concurrency.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { env } from "../../src/config/env.js";
import { ActiveExecutionLimitError, GlobalActiveExecutionLimitError, createExecutionWithinLimit } from "../../src/services/execution-limit.js";

const enabled = process.env.NIMBUS_POSTGRES_INTEGRATION === "1";
const FIELDS = { language: "cpp", code: "int main() {}", input: "" };

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describe("createExecutionWithinLimit with real Postgres", { skip: enabled ? false : "set NIMBUS_POSTGRES_INTEGRATION=1 to run", timeout: 120000 }, () => {
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

  const newUser = (name: string) => db.user.create({ data: { email: `${name}-${randomBytes(4).toString("hex")}@example.com`, password: "x" } });
  const unfinished = (userId: string) => db.execution.count({ where: { userId, status: { in: ["PENDING", "RUNNING"] } } });

  it("admits exactly the cap when 20 submissions race", async () => {
    const user = await newUser("burst");
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => createExecutionWithinLimit(db, user.id, FIELDS, 3)));

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    for (const result of results) {
      if (result.status === "rejected") assert.ok(result.reason instanceof ActiveExecutionLimitError, String(result.reason));
    }
    assert.equal(await unfinished(user.id), 3);
    assert.equal(await db.execution.count({ where: { userId: user.id } }), 3, "rejected submissions wrote nothing");
  });

  it("limits each user independently under concurrent load", async () => {
    const [a, b] = await Promise.all([newUser("a"), newUser("b")]);
    const results = await Promise.allSettled([a, b].flatMap((u) => Array.from({ length: 6 }, () => createExecutionWithinLimit(db, u.id, FIELDS, 2))));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
    assert.equal(await unfinished(a.id), 2);
    assert.equal(await unfinished(b.id), 2);
  });

  it("frees a slot when an execution finishes or fails", async () => {
    const user = await newUser("free");
    const first = await createExecutionWithinLimit(db, user.id, FIELDS, 2);
    const second = await createExecutionWithinLimit(db, user.id, FIELDS, 2);
    await assert.rejects(createExecutionWithinLimit(db, user.id, FIELDS, 2), ActiveExecutionLimitError);

    await db.execution.update({ where: { id: first.id }, data: { status: "COMPLETED" } });
    await createExecutionWithinLimit(db, user.id, FIELDS, 2);

    await db.execution.update({ where: { id: second.id }, data: { status: "FAILED" } });
    await createExecutionWithinLimit(db, user.id, FIELDS, 2);
    assert.equal(await unfinished(user.id), 2);
  });

  describe("global cap", () => {
    const UNFINISHED = ["PENDING", "RUNNING"];
    const unfinishedTotal = () => db.execution.count({ where: { status: { in: UNFINISHED } } });
    const totalRows = () => db.execution.count();
    // Each test starts with no unfinished executions anywhere, since the global cap counts every user's.
    const finishEverything = () => db.execution.updateMany({ where: { status: { in: UNFINISHED } }, data: { status: "COMPLETED" } });
    const newUsers = (prefix: string, count: number) => Promise.all(Array.from({ length: count }, (_, i) => newUser(`${prefix}${i}`)));

    it("admits exactly the global cap under a concurrent burst from many users, leaving no orphaned rows", async () => {
      await finishEverything();
      const users = await newUsers("g", 15);
      const rowsBefore = await totalRows();

      // A separate connection samples the committed unfinished count throughout the burst.
      const sampler = new PrismaClient({ datasourceUrl: testUrl });
      let maxSeen = 0;
      let sampling = true;
      const sampled = (async () => {
        while (sampling) maxSeen = Math.max(maxSeen, await sampler.execution.count({ where: { status: { in: UNFINISHED } } }));
      })();

      const results = await Promise.allSettled(users.flatMap((u) => [u, u].map(() => createExecutionWithinLimit(db, u.id, FIELDS, 2, 7))));
      sampling = false;
      await sampled;
      await sampler.$disconnect();

      assert.equal(results.filter((r) => r.status === "fulfilled").length, 7);
      for (const result of results) {
        if (result.status === "rejected") assert.ok(result.reason instanceof GlobalActiveExecutionLimitError, String(result.reason));
      }
      assert.equal(await unfinishedTotal(), 7);
      assert.equal((await totalRows()) - rowsBefore, 7, "rejected submissions rolled back without writing a row");
      assert.ok(maxSeen <= 7, `the cap was exceeded while the burst ran: saw ${maxSeen}`);
    });

    it("reports the user's own cap before the global cap", async () => {
      await finishEverything();
      const [heavy, light, newcomer] = await newUsers("p", 3);
      await createExecutionWithinLimit(db, heavy.id, FIELDS, 2, 3);
      await createExecutionWithinLimit(db, heavy.id, FIELDS, 2, 3);
      await createExecutionWithinLimit(db, light.id, FIELDS, 2, 3);

      await assert.rejects(createExecutionWithinLimit(db, heavy.id, FIELDS, 2, 3), ActiveExecutionLimitError);
      await assert.rejects(createExecutionWithinLimit(db, newcomer.id, FIELDS, 2, 3), GlobalActiveExecutionLimitError);
      assert.equal(await unfinishedTotal(), 3);
    });

    it("frees global capacity when any execution finishes, fails or times out", async () => {
      await finishEverything();
      const users = await newUsers("f", 4);
      const created = [];
      for (const u of users.slice(0, 3)) created.push(await createExecutionWithinLimit(db, u.id, FIELDS, 2, 3));
      await assert.rejects(createExecutionWithinLimit(db, users[3].id, FIELDS, 2, 3), GlobalActiveExecutionLimitError);

      // users[3] gets a per-user limit it can never reach here, so only the global cap applies to it.
      for (const [i, status] of ["COMPLETED", "FAILED", "TIMEOUT"].entries()) {
        await db.execution.update({ where: { id: created[i].id }, data: { status } });
        await createExecutionWithinLimit(db, users[3].id, FIELDS, 10, 3);
        await assert.rejects(createExecutionWithinLimit(db, users[3].id, FIELDS, 10, 3), GlobalActiveExecutionLimitError);
      }
      assert.equal(await unfinishedTotal(), 3);
    });

    it("counts RUNNING executions, and never exceeds the cap while executions finish during a burst", async () => {
      await finishEverything();
      const users = await newUsers("r", 10);
      const seeded = [];
      for (const u of users.slice(0, 4)) seeded.push(await createExecutionWithinLimit(db, u.id, FIELDS, 2, 5));
      await db.execution.updateMany({ where: { id: { in: seeded.map((s) => s.id) } }, data: { status: "RUNNING" } });

      // Two executions finish (using the processor's status-conditioned update) while 20 submissions race.
      const results = await Promise.allSettled([
        ...users.flatMap((u) => [u, u].map(() => createExecutionWithinLimit(db, u.id, FIELDS, 2, 5))),
        ...seeded.slice(0, 2).map((s) => db.execution.updateMany({ where: { id: s.id, status: { in: UNFINISHED } }, data: { status: "COMPLETED" } })),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          assert.ok(result.reason instanceof GlobalActiveExecutionLimitError || result.reason instanceof ActiveExecutionLimitError, String(result.reason));
        }
      }
      assert.ok((await unfinishedTotal()) <= 5, `unfinished ${await unfinishedTotal()} exceeds the cap`);
      assert.equal(await db.execution.count({ where: { id: { in: seeded.slice(2).map((s) => s.id) }, status: "RUNNING" } }), 2);
    });

    it("does not apply a global cap when it is 0", async () => {
      await finishEverything();
      const users = await newUsers("z", 12);
      const results = await Promise.allSettled(users.map((u) => createExecutionWithinLimit(db, u.id, FIELDS, 2, 0)));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 12);
      assert.equal(await unfinishedTotal(), 12);
    });
  });
});
