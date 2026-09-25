import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import mysql from "mysql2/promise";
import { createRuntime } from "../src/runtime";
import { MysqlSqlExecutor, type MysqlPoolLike } from "../src/executor/mysql";
import { MysqlIntrospector } from "../src/introspector/mysql";
import { MysqlDdlGenerator } from "../src/ddl/mysql";
import { SchemaDiffer } from "../src/differ";
import { Migrator } from "../src/migrator";
import { DatabaseMigrationHistoryStore, FileMigrationStore, checksumOf } from "../src/store";

const run = process.env.MYSQL_HOST ? describe : describe.skip;
run.sequential("MySQL 端到端迁移", () => {
  let dir: string, database: string, admin: mysql.Connection, pool: mysql.Pool;
  let executor: MysqlSqlExecutor;
  let created: boolean;
  const connection = {
    host: process.env.MYSQL_HOST!, port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root", password: process.env.MYSQL_PASSWORD ?? "tgm-test-only",
  };
  beforeEach(async () => {
    created = false;
    dir = await mkdtemp(path.join(tmpdir(), "tgm-mysql-"));
    // MYSQL_DATABASE is intentionally not used: only a database created by this test is owned.
    database = `tgm_test_${randomUUID().replaceAll("-", "")}`;
    admin = await mysql.createConnection(connection);
    await admin.query(`create database \`${database}\``);
    created = true;
    pool = mysql.createPool({ ...connection, database, multipleStatements: true });
    executor = new MysqlSqlExecutor(pool as unknown as MysqlPoolLike);
  });
  afterEach(async () => {
    try { if (pool) await pool.end(); }
    finally {
      try { if (created) await admin.query(`drop database \`${database}\``); }
      finally { if (admin) await admin.end(); if (dir) await rm(dir, { recursive: true, force: true }); }
    }
  });
  it("dev 建表、重复运行幂等", async () => {
    const config = {
      dialect: "mysql" as const, database: { ...connection, database },
      models: ["./tests/model/model.ts"], migrationsDir: path.join(dir, "migrations"), lockPath: path.join(dir, "lock"),
    };
    const runtime = await createRuntime(config, path.resolve("."));
    try {
      const first = await runtime.migrator.dev({ name: "init" });
      expect(first.applied).toBe(true);
      expect(first.drift).toEqual([]);
      const second = await runtime.migrator.dev({});
      expect(second.applied).toBe(false);
      expect(second.diff.changes).toEqual([]);
      expect((await runtime.migrator.status()).applied).toHaveLength(1);
    } finally { await runtime.close(); }
  });
  it("varchar to int drops charset/collation and preserves data", async () => {
    await executor.query("create table t (v varchar(20) character set utf8mb4 collate utf8mb4_bin)");
    await executor.query("insert into t values ('123')");
    const introspector = new MysqlIntrospector({ query: executor });
    const from = await introspector.introspect();
    const to = { tables: from.tables.map(t => ({ ...t, columns: t.columns.map(c => ({ ...c, type: "int", mysql: undefined })) })) };
    const diff = new SchemaDiffer().diff(from, to);
    await executor.executeStatements(new MysqlDdlGenerator().statements(diff, { from, to }));
    expect((await executor.query("select v from t")).rows[0]?.v).toBe(123);
    expect((await introspector.introspect()).tables[0]?.columns[0]?.type).toBe("int");
  });
  it("committed SQL with failed history blocks replay until resolve", async () => {
    await executor.query("create table counter (value int)");
    await executor.query("insert into counter values (0)");
    const history = new DatabaseMigrationHistoryStore({ executor, dialect: "mysql" });
    const files = new FileMigrationStore(path.join(dir, "migrations"));
    const sql = "update counter set value=value+1";
    await files.write({ id: "one", sortKey: "one", sql, checksum: checksumOf(sql) });
    const introspector = new MysqlIntrospector({ query: executor });
    const migrator = new Migrator({ files, history, executor, introspector, ddl: new MysqlDdlGenerator(), targetSchema: () => introspector.introspect(), migrationsDir: dir, lockPath: path.join(dir, "lock") });
    const failure = vi.spyOn(history, "recordApplied").mockRejectedValue(new Error("history unavailable"));
    await expect(migrator.deploy()).rejects.toThrow("history unavailable");
    failure.mockRestore();
    await expect(migrator.deploy()).rejects.toThrow(/failed/);
    expect((await executor.query("select value from counter")).rows[0]?.value).toBe(1);
    await migrator.resolve({ migration: "one", action: "applied" });
    expect((await migrator.deploy()).applied).toEqual([]);
  });
});
