import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteSqlExecutor } from "../src/executor/sqlite";
import { DatabaseMigrationHistoryStore, FileMigrationStore, checksumOf } from "../src/store";
import { Migrator } from "../src/migrator";
import type { SqlQueryable } from "../src/sql";
import type { MigrationFile } from "../src/store";

it("SQLite rolls back SQL and success history together, retaining the recovery guard", async () => {
  const db = new Database(":memory:");
  const dir = await mkdtemp(path.join(tmpdir(), "tgm-reliability-"));
  try {
    const executor = new SqliteSqlExecutor(db);
    const history = new DatabaseMigrationHistoryStore({ executor, dialect: "sqlite" });
    const files = new FileMigrationStore(dir);
    const sql = "create table business (id integer); insert into business values (1);";
    await files.write({ id: "first", sortKey: "first", sql, checksum: checksumOf(sql) });
    const migrator = new Migrator({ files, history, executor, introspector: { dialect: "sqlite", introspect: async () => ({ tables: [] }) }, ddl: { dialect: "sqlite", statements: () => [], createStatements: () => [] }, targetSchema: async () => ({ tables: [] }), migrationsDir: dir, lockPath: path.join(dir, "lock") });
    expect((await migrator.status()).pending).toEqual(["first"]);
    const record = history.recordApplied.bind(history);
    const failure = vi.spyOn(history, "recordApplied").mockImplementation(async (file: MigrationFile, connection?: SqlQueryable) => {
      await record(file, connection);
      throw new Error("failure after success record");
    });
    await expect(migrator.deploy()).rejects.toThrow("failure after success record");
    expect(db.prepare("select name from sqlite_master where name='business'").all()).toEqual([]);
    expect((await history.listApplied())[0]?.failed).toBe(true);
    failure.mockRestore();
    await expect(migrator.deploy()).rejects.toThrow(/失败/);
    await migrator.resolve({ migration: "first", action: "rolled-back" });
    await migrator.deploy();
    expect(db.prepare("select count(*) as n from business").get()).toEqual({ n: 1 });
    expect((await history.listApplied())[0]?.failed).toBe(false);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

describe("missing history is distinct from query failure", () => {
  for (const [dialect, missing, denied] of [
    ["postgres", { code: "42P01" }, { code: "42501" }],
    ["mysql", { code: "ER_NO_SUCH_TABLE" }, { code: "ER_TABLEACCESS_DENIED_ERROR" }],
    ["sqlite", { code: "SQLITE_ERROR", message: "no such table: _migrations" }, { code: "SQLITE_READONLY" }],
    ["mssql", { number: 208 }, { number: 229 }],
    ["oracle", { errorNum: 942 }, { errorNum: 1031 }],
  ] as const) {
    it(dialect, async () => {
      const query = vi.fn().mockRejectedValueOnce(missing);
      if (dialect === "oracle") query.mockResolvedValueOnce({ rows: [{ owner: "TEST" }] }).mockResolvedValueOnce({ rows: [] });
      query.mockRejectedValueOnce(denied);
      const history = new DatabaseMigrationHistoryStore({ dialect, schema: "TEST", executor: { query, executeStatements: async () => {}, acquireMigrationLock: async () => async () => {} } });
      expect(await history.listApplied()).toEqual([]);
      await expect(history.listApplied()).rejects.toBe(denied);
    });
  }
});

it("Oracle does not hide an inaccessible history table in another schema", async () => {
  const error = { errorNum: 942 };
  const query = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ rows: [{ owner: "OTHER" }] });
  const history = new DatabaseMigrationHistoryStore({ dialect: "oracle", schema: "TARGET", executor: { query, executeStatements: async () => {}, acquireMigrationLock: async () => async () => {} } });
  await expect(history.listApplied()).rejects.toBe(error);
});
