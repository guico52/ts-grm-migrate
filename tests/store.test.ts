import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checksumOf,
  DatabaseMigrationHistoryStore,
  FileMigrationStore,
} from "../src/store";
import type { SqlExecutor } from "../src/executor";

class FakeExecutor implements SqlExecutor {
  readonly queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
  readonly statements: Array<ReadonlyArray<string>> = [];
  private _rows: ReadonlyArray<Record<string, unknown>> = [];

  setRows(rows: ReadonlyArray<Record<string, unknown>>): void {
    this._rows = rows;
  }

  async query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    this.queries.push(params === undefined ? { sql } : { sql, params });
    return { rows: this._rows };
  }

  async executeStatements(statements: ReadonlyArray<string>): Promise<void> {
    this.statements.push(statements);
  }

  async acquireMigrationLock(): Promise<() => Promise<void>> {
    return async () => undefined;
  }
}

describe("FileMigrationStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("目录不存在时返回空列表（而非报错）", async () => {
    const store = new FileMigrationStore(path.join(dir, "nope"));
    expect(await store.listFiles()).toEqual([]);
  });

  it("按 id 字典序列出 .sql，忽略其他文件", async () => {
    await writeFile(path.join(dir, "20260911T120001_b.sql"), "select 2;");
    await writeFile(path.join(dir, "20260911T120000_a.sql"), "select 1;");
    await writeFile(path.join(dir, "README.md"), "not a migration");
    const files = await new FileMigrationStore(dir).listFiles();
    expect(files.map((f) => f.id)).toEqual([
      "20260911T120000_a",
      "20260911T120001_b",
    ]);
    expect(files[0]!.sortKey).toBe("20260911T120000_a");
  });

  it("checksum 由内容决定，内容改了 checksum 就变", async () => {
    const store = new FileMigrationStore(dir);
    await writeFile(path.join(dir, "m1.sql"), "select 1;");
    const [first] = await store.listFiles();
    expect(first!.checksum).toBe(checksumOf("select 1;"));

    await writeFile(path.join(dir, "m1.sql"), "select 2;");
    const [second] = await store.listFiles();
    expect(second!.checksum).not.toBe(first!.checksum);
  });

  it("write 自动建目录并写入 <id>.sql", async () => {
    const nested = path.join(dir, "migrations");
    await new FileMigrationStore(nested).write({
      id: "m1",
      sql: "select 1;\n",
      checksum: "irrelevant",
      sortKey: "m1",
    });
    expect(await readdir(nested)).toEqual(["m1.sql"]);
  });
});

describe("DatabaseMigrationHistoryStore", () => {
  it("ensureTable 使用带引号的表名与幂等建表", async () => {
    const executor = new FakeExecutor();
    await new DatabaseMigrationHistoryStore({ executor }).ensureTable();
    expect(executor.statements[0]![0]).toContain(
      'create table if not exists "_migrations"',
    );
  });

  it("自定义表名被加引号（防保留字/大小写折叠）", async () => {
    const executor = new FakeExecutor();
    await new DatabaseMigrationHistoryStore({
      executor,
      table: "my history",
    }).ensureTable();
    expect(executor.statements[0]![0]).toContain('"my history"');
  });

  it("listApplied 映射行：日期、failed、error、缺失的可空字段", async () => {
    const executor = new FakeExecutor();
    executor.setRows([
      {
        id: "m1",
        checksum: "abc",
        applied_at: new Date("2026-01-01T00:00:00Z"),
        rolled_back_at: null,
        failed: true,
        error: "boom",
      },
    ]);
    const applied = await new DatabaseMigrationHistoryStore({ executor }).listApplied();
    expect(applied[0]).toMatchObject({
      id: "m1",
      checksum: "abc",
      failed: true,
      error: "boom",
      rolledBackAt: undefined,
    });
    expect(applied[0]!.appliedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("recordApplied 走 upsert（重复 id 不报错）并传 id/checksum", async () => {
    const executor = new FakeExecutor();
    const store = new DatabaseMigrationHistoryStore({ executor });
    await store.recordApplied({
      id: "m1",
      sql: "select 1;",
      checksum: "abc",
      sortKey: "m1",
    });
    expect(executor.queries[0]!.sql).toContain("on conflict (id) do update");
    expect(executor.queries[0]!.params).toEqual(["m1", "abc"]);
  });

  it("markFailed 写 failed / error / logs 与原因", async () => {
    const executor = new FakeExecutor();
    const store = new DatabaseMigrationHistoryStore({ executor });
    await store.markFailed("m1", "boom", "详细日志");
    expect(executor.queries[0]!.sql).toContain("failed = true");
    expect(executor.queries[0]!.params).toEqual(["m1", "boom", "详细日志"]);
  });

  it("markFailed 不传 logs 时写入 null", async () => {
    const executor = new FakeExecutor();
    const store = new DatabaseMigrationHistoryStore({ executor });
    await store.markFailed("m1", "boom");
    expect(executor.queries[0]!.params).toEqual(["m1", "boom", null]);
  });

  it("markRolledBack 用 UPDATE 标记回滚（保留记录作审计）", async () => {
    const executor = new FakeExecutor();
    executor.setRows([{ id: "m1" }]); // returning id 命中一行
    const store = new DatabaseMigrationHistoryStore({ executor });
    const updated = await store.markRolledBack("m1");
    expect(updated).toBe(true);
    expect(executor.queries[0]!.sql).toContain("rolled_back_at = now()");
    expect(executor.queries[0]!.sql).toContain("returning id");
    expect(executor.queries[0]!.params).toEqual(["m1"]);
  });

  it("markRolledBack 未命中记录时返回 false（让调用方报错）", async () => {
    const executor = new FakeExecutor(); // rows 为空
    const store = new DatabaseMigrationHistoryStore({ executor });
    expect(await store.markRolledBack("nope")).toBe(false);
  });

  it("ensureTable 幂等补上后加的列（历史表自身的演进）", async () => {
    const executor = new FakeExecutor();
    await new DatabaseMigrationHistoryStore({ executor }).ensureTable();
    expect(executor.statements[0]![0]).toContain("create table if not exists");
    expect(executor.statements[1]![0]).toContain(
      "add column if not exists logs text",
    );
  });

});
