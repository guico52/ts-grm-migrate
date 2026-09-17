/**
 * Migrator 端到端集成测试 —— **需要真实数据库**，无 PG_HOST 时整体跳过。
 *
 * 连接信息全部来自环境变量（同 tests/manual-postgres.test.ts）：
 *   PG_HOST（必填，未设置则跳过） / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD
 *
 * 运行：`PG_HOST=... PG_PASSWORD=... yarn vitest run tests/migrator-postgres.test.ts`
 *
 * 在独立 schema 中执行（不触碰 public）：给连接池设 `search_path`，这样迁移 SQL
 * 里不带 schema 前缀也能落对位置 —— 与真实用法一致（migrate 生成的 SQL 就是不带前缀的）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { PostgresSqlExecutor } from "../src/executor/postgres";
import type { PgPoolLike } from "../src/executor/postgres";
import { PostgresIntrospector } from "../src/introspector/postgres";
import { PostgresDdlGenerator } from "../src/ddl/postgres";
import { Migrator } from "../src/migrator";
import { DatabaseMigrationHistoryStore, FileMigrationStore } from "../src/store";
import { createSchema } from "../src/vendor/ts-grm";
import { tableDefsToSchema } from "../src/schema/adapter";
import { createTestPostgresClient } from "./util/ts-grm-client";

const PG_HOST = process.env.PG_HOST;
const PG_CONFIG = {
  host: PG_HOST ?? "",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "ts_grm_migrate_test",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "",
};

const TEST_SCHEMA = "ts_grm_migrate_e2e";
const MODEL_TABLES = ["author", "book", "book_tag_mapping", "tag"];

const describePg = PG_HOST != null ? describe.sequential : describe.skip;

describePg("Migrator 集成（真实数据库）", () => {
  const { sqlClient, pool } = createTestPostgresClient(PG_CONFIG);
  let execPool: Pool;
  let executor: PostgresSqlExecutor;
  let fileStore: FileMigrationStore;
  let dir: string;

  beforeAll(async () => {
    await pool.query(`drop schema if exists "${TEST_SCHEMA}" cascade`);
    await pool.query(`create schema "${TEST_SCHEMA}"`);
    // 专用连接池：所有连接默认在该 schema 下（迁移 SQL 不带 schema 前缀）
    execPool = new Pool({ ...PG_CONFIG, max: 2, options: `-c search_path=${TEST_SCHEMA}` });
    executor = new PostgresSqlExecutor(execPool as unknown as PgPoolLike);
  });

  afterAll(async () => {
    await execPool.end();
    await pool.query(`drop schema if exists "${TEST_SCHEMA}" cascade`).catch(() => undefined);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`drop schema if exists "${TEST_SCHEMA}" cascade`);
    await pool.query(`create schema "${TEST_SCHEMA}"`);
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-e2e-"));
    fileStore = new FileMigrationStore(path.join(dir, "migrations"));
  });

  afterEach(async () => {
    if (dir != null) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  function makeMigrator(): Migrator {
    return new Migrator({
      files: fileStore,
      history: new DatabaseMigrationHistoryStore({ executor }),
      executor,
      introspector: new PostgresIntrospector({ query: executor, schema: TEST_SCHEMA }),
      ddl: new PostgresDdlGenerator(),
      targetSchema: async () => {
        const tableDefs = await createSchema(sqlClient);
        return tableDefsToSchema(tableDefs, sqlClient.driver);
      },
      migrationsDir: path.join(dir, "migrations"),
      lockPath: path.join(dir, "migrate.lock"),
    });
  }

  async function tablesInSchema(): Promise<Array<string>> {
    const { rows } = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name <> '_migrations'
       order by table_name`,
      [TEST_SCHEMA],
    );
    return rows.map((r) => String(r["table_name"]));
  }

  it("dev：从模型生成迁移、应用，表真的建出来了", async () => {
    const migrator = makeMigrator();

    const result = await migrator.dev({ name: "init" });

    expect(result.applied).toBe(true);
    expect(result.migrationId).toBeDefined();
    expect(await tablesInSchema()).toEqual(MODEL_TABLES);

    // 迁移文件写入磁盘
    const files = await fileStore.listFiles();
    expect(files.map((f) => f.id)).toEqual([result.migrationId]);
    expect(files[0]!.sql).toContain("create table");
  });

  it("dev：模型未变时第二次运行不再产生迁移（introspect ≡ 模型）", async () => {
    const migrator = makeMigrator();
    await migrator.dev({ name: "init" });

    const second = await migrator.dev({ name: "again" });

    expect(second.diff.changes).toEqual([]);
    expect(second.migrationId).toBeUndefined();
    expect(second.applied).toBe(false);
    expect((await fileStore.listFiles()).length).toBe(1);
  });

  it("migrate 建的表能被「无引号查询」命中（与 ts-grm 运行时一致）", async () => {
    // ts-grm 生成的 SQL 不带引号（如 `select ... from AUTHOR`，PG 会折叠为小写）。
    // 若 migrate 建出的是带引号的大写表 "AUTHOR"，下面这些查询会找不到表 ——
    // 这正是「应用跑不起来」的现场复现。
    const migrator = makeMigrator();
    await migrator.dev({ name: "init" });

    const client = await execPool.connect(); // search_path 已指向测试 schema
    try {
      for (const table of ["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]) {
        const { rows } = await client.query(`select * from ${table} limit 0`);
        expect(rows).toEqual([]);
      }
    } finally {
      client.release();
    }
  });

  it("deploy：重复运行幂等（不重复应用）", async () => {
    const migrator = makeMigrator();
    await migrator.dev({ name: "init" });

    const result = await migrator.deploy();

    expect(result.applied).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(await tablesInSchema()).toEqual(MODEL_TABLES);
  });

  it("deploy：历史表记录了已应用的迁移与 checksum", async () => {
    const migrator = makeMigrator();
    const dev = await migrator.dev({ name: "init" });

    const { rows } = await executeQuery(
      `select id, checksum, failed from "${TEST_SCHEMA}"."_migrations"`,
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!["id"]).toBe(dev.migrationId);
    expect(rows[0]!["failed"]).toBe(false);
    const files = await fileStore.listFiles();
    expect(rows[0]!["checksum"]).toBe(files[0]!.checksum);
  });

  it("deploy：已应用迁移被改动后拒绝继续（漂移检测）", async () => {
    const migrator = makeMigrator();
    await migrator.dev({ name: "init" });

    const [file] = await fileStore.listFiles();
    await fileStore.write({ ...file!, sql: `${file!.sql}\n-- tampered\n` });

    await expect(migrator.deploy()).rejects.toThrow(/checksum/);
  });

  it("push：直接同步，不写迁移文件也不建历史表", async () => {
    const migrator = makeMigrator();

    const result = await migrator.push();

    expect(result.statements.length).toBeGreaterThan(0);
    expect(await tablesInSchema()).toEqual(MODEL_TABLES);
    expect(await fileStore.listFiles()).toEqual([]);

    const { rows } = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name = '_migrations'`,
      [TEST_SCHEMA],
    );
    expect(rows.length).toBe(0);
  });

  /** 直接查测试 schema（绕过 search_path 的池） */
  async function executeQuery(sql: string) {
    return await pool.query(sql);
  }
});
