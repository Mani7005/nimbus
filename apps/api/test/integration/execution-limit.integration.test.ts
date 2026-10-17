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
import { ActiveExecutionLimitError, createExecutionWithinLimit } from "../../src/services/execution-limit.js";

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
});
