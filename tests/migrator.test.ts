import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checksumOf, FileMigrationStore } from "../src/store";
import { generateMigrationId, Migrator, toSqlFile } from "../src/migrator";
import type {
  AppliedMigration,
  MigrationFile,
  MigrationHistoryStore,
} from "../src/store";
import type { SqlExecutor } from "../src/executor";
import type { Dialect, Introspector } from "../src/introspector";
import type { DdlGenerator } from "../src/ddl";
import type { Diff } from "../src/diff/types";
import type { Schema } from "../src/schema/model";

const EMPTY: Schema = { tables: [] };
const ONE_TABLE: Schema = {
  tables: [
    {
      name: "T",
      columns: [
        {
          name: "ID",
          type: "bigint",
          nullable: false,
          length: undefined,
          default: undefined,
          autoIncrement: false,
          ordinal: 1,
          comment: undefined,
        },
      ],
      constraints: [],
      indexes: [],
    },
  ],
};

class FakeHistory implements MigrationHistoryStore {
  readonly tableName = "_migrations";
  readonly applied: Array<AppliedMigration> = [];
  readonly failures: Array<{ id: string; error: string }> = [];
  readonly deleted: Array<string> = [];

  async ensureTable(): Promise<void> {}
  async listApplied(): Promise<ReadonlyArray<AppliedMigration>> {
    return this.applied;
  }
  async recordApplied(migration: MigrationFile): Promise<void> {
    this.applied.push({
      id: migration.id,
      checksum: migration.checksum,
      appliedAt: new Date(),
      rolledBackAt: undefined,
      failed: false,
      error: undefined,
    });
  }
  async markFailed(id: string, error: string): Promise<void> {
    this.failures.push({ id, error });
  }
  async delete(id: string): Promise<void> {
    this.deleted.push(id);
    const index = this.applied.findIndex((a) => a.id === id);
    if (index >= 0) {
      this.applied.splice(index, 1);
    }
  }
}

class FakeExecutor implements SqlExecutor {
  readonly executed: Array<ReadonlyArray<string>> = [];
  failWhen: string | undefined;

  async query(): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    return { rows: [] };
  }
  async executeStatements(statements: ReadonlyArray<string>): Promise<void> {
    const failWhen = this.failWhen;
    if (failWhen != null && statements.some((s) => s.includes(failWhen))) {
      throw new Error("语句执行失败（已回滚）：boom");
    }
    this.executed.push(statements);
  }
  async acquireMigrationLock(): Promise<() => Promise<void>> {
    return async () => undefined;
  }
}

class FakeIntrospector implements Introspector {
  readonly dialect: Dialect = "postgres";
  schema: Schema = EMPTY;
  async introspect(): Promise<Schema> {
    return this.schema;
  }
}

class FakeDdl implements DdlGenerator {
  readonly dialect: Dialect = "postgres";
  statements(_diff: Diff): ReadonlyArray<string> {
    return ['create table "T" ("ID" bigint not null)'];
  }
  createStatements(): ReadonlyArray<string> {
    return [];
  }
}

describe("Migrator", () => {
  let dir: string;
  let files: FileMigrationStore;
  let history: FakeHistory;
  let executor: FakeExecutor;
  let introspector: FakeIntrospector;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-migrator-"));
    files = new FileMigrationStore(path.join(dir, "migrations"));
    history = new FakeHistory();
    executor = new FakeExecutor();
    introspector = new FakeIntrospector();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeMigrator(target: Schema = EMPTY): Migrator {
    return new Migrator({
      files,
      history,
      executor,
      introspector,
      ddl: new FakeDdl(),
      targetSchema: async () => target,
      migrationsDir: path.join(dir, "migrations"),
      lockPath: path.join(dir, "migrate.lock"),
    });
  }

  async function writeMigration(id: string, sql: string): Promise<MigrationFile> {
    const file: MigrationFile = { id, sql, checksum: checksumOf(sql), sortKey: id };
    await files.write(file);
    return file;
  }

  function markApplied(file: MigrationFile, checksum = file.checksum): void {
    history.applied.push({
      id: file.id,
      checksum,
      appliedAt: new Date(),
      rolledBackAt: undefined,
      failed: false,
      error: undefined,
    });
  }

  describe("deploy", () => {
    it("按 sortKey 顺序应用未应用的迁移，并记录历史", async () => {
      await writeMigration("20260911T120001_b", "select 2;");
      await writeMigration("20260911T120000_a", "select 1;");

      const result = await makeMigrator().deploy();

      expect(result.applied).toEqual([
        "20260911T120000_a",
        "20260911T120001_b",
      ]);
      expect(result.skipped).toBe(0);
      expect(executor.executed.map((s) => s[0])).toEqual(["select 1;", "select 2;"]);
      expect(history.applied.map((a) => a.id)).toEqual([
        "20260911T120000_a",
        "20260911T120001_b",
      ]);
    });

    it("跳过已应用且 checksum 一致的迁移", async () => {
      const a = await writeMigration("20260911T120000_a", "select 1;");
      await writeMigration("20260911T120001_b", "select 2;");
      markApplied(a);

      const result = await makeMigrator().deploy();

      expect(result.applied).toEqual(["20260911T120001_b"]);
      expect(result.skipped).toBe(1);
      expect(executor.executed).toEqual([["select 2;"]]);
    });

    it("已应用迁移的文件被改动 → 拒绝继续（checksum 漂移）", async () => {
      const a = await writeMigration("20260911T120000_a", "select 1;");
      markApplied(a, "deadbeef");

      await expect(makeMigrator().deploy()).rejects.toThrow(/checksum/);
      expect(executor.executed).toEqual([]);
    });

    it("历史里有、磁盘上缺失的迁移 → 拒绝继续", async () => {
      history.applied.push({
        id: "20260911T000000_gone",
        checksum: "x",
        appliedAt: new Date(),
        rolledBackAt: undefined,
        failed: false,
        error: undefined,
      });

      await expect(makeMigrator().deploy()).rejects.toThrow(/缺失/);
    });

    it("迁移执行失败 → 记入历史、抛出，且后续迁移不再执行", async () => {
      await writeMigration("20260911T120000_a", "select 1;");
      await writeMigration("20260911T120001_b", "select 2;");
      executor.failWhen = "select 1;";

      await expect(makeMigrator().deploy()).rejects.toThrow(/执行失败/);

      expect(history.failures.map((f) => f.id)).toEqual(["20260911T120000_a"]);
      expect(history.applied).toEqual([]);
    });

    it("无迁移文件时是空操作", async () => {
      const result = await makeMigrator().deploy();
      expect(result).toEqual({ applied: [], skipped: 0 });
    });
  });

  describe("dev", () => {
    it("无差异时不生成任何文件", async () => {
      const result = await makeMigrator(EMPTY).dev({ name: "init" });

      expect(result.migrationId).toBeUndefined();
      expect(result.applied).toBe(false);
      expect(result.diff.changes).toEqual([]);
      expect(await files.listFiles()).toEqual([]);
    });

    it("有差异时生成迁移文件、应用并记录", async () => {
      introspector.schema = EMPTY;

      const result = await makeMigrator(ONE_TABLE).dev({ name: "init" });

      expect(result.migrationId).toBeDefined();
      expect(result.applied).toBe(true);

      const listed = await files.listFiles();
      expect(listed.map((f) => f.id)).toEqual([result.migrationId]);
      expect(listed[0]!.sql).toContain("create table");
      expect(history.applied.map((a) => a.id)).toEqual([result.migrationId]);
      expect(executor.executed.length).toBe(1);
    });

    it("diff 时排除 migrate 自己的历史表（否则会生成 DROP 把它删掉）", async () => {
      // 现状：业务表 + migrate 自己的记账表；目标态只有业务表
      introspector.schema = {
        tables: [
          { name: "_migrations", columns: [], constraints: [], indexes: [] },
          ...ONE_TABLE.tables,
        ],
      };

      const result = await makeMigrator(ONE_TABLE).dev({ name: "init" });

      expect(result.diff.changes).toEqual([]);
      expect(result.migrationId).toBeUndefined();
    });

    it("迁移 id 含名字 slug 且以时间戳开头", async () => {
      const result = await makeMigrator(ONE_TABLE).dev({ name: "add user table" });
      expect(result.migrationId).toMatch(/^\d{14}_add_user_table$/);
    });
  });

  describe("resolve（失败后的恢复途径）", () => {
    async function markFailedRecord(id: string): Promise<void> {
      history.applied.push({
        id,
        checksum: "",
        appliedAt: new Date(),
        rolledBackAt: undefined,
        failed: true,
        error: "boom",
      });
    }

    it("applied：记为已应用，checksum 取自磁盘当前内容", async () => {
      const a = await writeMigration("20260911T120000_a", "select 1;");

      await makeMigrator().resolve({ migration: a.id, action: "applied" });

      expect(history.applied.map((x) => x.id)).toEqual([a.id]);
      expect(history.applied[0]!.checksum).toBe(a.checksum);
    });

    it("rolled-back：清除记录，使它重新待应用", async () => {
      await writeMigration("20260911T120000_a", "select 1;");
      await markFailedRecord("20260911T120000_a");

      await makeMigrator().resolve({
        migration: "20260911T120000_a",
        action: "rolled-back",
      });

      expect(history.deleted).toEqual(["20260911T120000_a"]);
      expect(history.applied).toEqual([]);
    });

    it("迁移不在磁盘上时拒绝", async () => {
      await expect(
        makeMigrator().resolve({ migration: "20260911T000000_nope", action: "applied" }),
      ).rejects.toThrow(/不在磁盘上/);
    });

    it("闭环：失败迁移阻塞 deploy，resolve 后恢复可用", async () => {
      await writeMigration("20260911T120000_a", "select 1;");
      await markFailedRecord("20260911T120000_a");

      // 未处理前：deploy 被拒绝
      await expect(makeMigrator().deploy()).rejects.toThrow(/上次执行失败/);

      // 清除失败记录后：重新变成待应用，deploy 正常
      await makeMigrator().resolve({
        migration: "20260911T120000_a",
        action: "rolled-back",
      });
      const result = await makeMigrator().deploy();

      expect(result.applied).toEqual(["20260911T120000_a"]);
      expect(history.applied.map((a) => a.id)).toEqual(["20260911T120000_a"]);
    });
  });

  describe("push", () => {
    it("直接执行 diff 语句，不写迁移文件、不记历史", async () => {
      const result = await makeMigrator(ONE_TABLE).push();

      expect(result.statements.length).toBe(1);
      expect(executor.executed.length).toBe(1);
      expect(await files.listFiles()).toEqual([]);
      expect(history.applied).toEqual([]);
    });
  });
});

describe("generateMigrationId", () => {
  it("UTC 时间戳 + 名字 slug", () => {
    expect(generateMigrationId(new Date("2026-09-11T12:34:56Z"), "Add User Table")).toBe(
      "20260911123456_add_user_table",
    );
  });

  it("名字为空时只留时间戳", () => {
    expect(generateMigrationId(new Date("2026-09-11T12:34:56Z"), "   ")).toBe(
      "20260911123456",
    );
  });
});

describe("toSqlFile", () => {
  it("语句间空行分隔，统一补分号，末尾换行", () => {
    expect(toSqlFile(["create table A", "alter table B;"])).toBe(
      "create table A;\n\nalter table B;\n",
    );
  });
});
