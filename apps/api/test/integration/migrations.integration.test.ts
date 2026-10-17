// REAL Postgres: skipped unless NIMBUS_POSTGRES_INTEGRATION=1. Uses the server in DATABASE_URL, but never its
// database: it creates a throwaway database (nimbus_it_<random>), applies prisma/migrations with `prisma migrate
// deploy` exactly as a deployment would, and drops it afterwards.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { env } from "../../src/config/env.js";
import { listExecutionsPage } from "../../src/services/execution-history.js";

const enabled = process.env.NIMBUS_POSTGRES_INTEGRATION === "1";
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function prisma(args: string[], databaseUrl: string) {
  return spawnSync(process.execPath, [prismaCli, ...args], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: "utf8" });
}

describe("prisma migrations on a fresh database", { skip: enabled ? false : "set NIMBUS_POSTGRES_INTEGRATION=1 to run", timeout: 180000 }, () => {
  const database = `nimbus_it_${randomBytes(6).toString("hex")}`;
  const admin = new PrismaClient({ datasourceUrl: withDatabase(env.DATABASE_URL, "postgres") });
  const testUrl = withDatabase(env.DATABASE_URL, database);
  let db: PrismaClient;

  before(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: testUrl }, stdio: "ignore" });
    db = new PrismaClient({ datasourceUrl: testUrl });
  });

  after(async () => {
    await db?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.$disconnect();
  });

  it("creates the (userId, status) index", async () => {
    const indexes = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Execution' ORDER BY indexname`;
    assert.deepEqual(
      indexes.map((i) => i.indexname),
      ["Execution_pkey", "Execution_userId_status_idx"],
    );
    assert.match(indexes[1].indexdef, /USING btree \("userId", status\)/);
  });

  it("leaves no drift between the migrations and schema.prisma", () => {
    const diff = prisma(["migrate", "diff", "--from-url", testUrl, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code"], testUrl);
    assert.equal(diff.status, 0, `schema drift:\n${diff.stdout}${diff.stderr}`);
  });

  it("is idempotent: deploying again applies nothing", () => {
    const again = prisma(["migrate", "deploy"], testUrl);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /No pending migrations to apply/);
  });

  it("lets Postgres answer the unfinished-execution count from the index", async () => {
    const plan = await db.$transaction(async (tx) => {
      // The table is tiny, so forbid sequential scans to see whether the index is usable at all.
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT count(*) FROM "Execution" WHERE "userId" = 'u' AND status IN ('PENDING', 'RUNNING')`,
      );
    });
    assert.match(plan.map((row) => row["QUERY PLAN"]).join("\n"), /Index Only Scan using "Execution_userId_status_idx"/);
  });

  it("pages through real rows in stable order, including equal timestamps", async () => {
    const user = await db.user.create({ data: { email: `pages-${database}@example.com`, password: "x" } });
    const tie = new Date("2026-10-01T00:00:00Z");
    for (let i = 0; i < 11; i++) {
      await db.execution.create({
        data: { userId: user.id, language: "cpp", code: "", status: "COMPLETED", createdAt: i < 6 ? tie : new Date(tie.getTime() + i * 1000) },
      });
    }
    const expected = (await db.execution.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })).map((e) => e.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await listExecutionsPage(db, user.id, { limit: 3, cursor });
      assert.ok(page);
      seen.push(...page.executions.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, expected);
  });
});
