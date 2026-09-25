/**
 * Migrator —— 迁移应用器：文件扫描 → 与历史比对 → 按序执行 → 记录。
 *
 * 对应 prisma-engines 的 `apply_migration.rs` 与命令层 `apply_migrations.rs`。
 *
 * 三条路径：
 * - `deploy()`：应用所有未应用的迁移（无交互，部署/CI 用）
 * - `dev()`：introspect → diff → 生成迁移文件 → 应用（开发用）
 * - `push()`：diff 后直接应用，不写迁移文件、不记历史（快速同步）
 *
 * 可靠性（两层锁 + 漂移检测）：
 * - **进程锁文件**（`src/lock.ts`）：同一项目上不允许并发运行多个实例
 * - **数据库 advisory lock**：同一数据库上不允许多机并发迁移（进程锁管不到别的机器）
 * - **checksum 漂移检测**：已应用的迁移文件不得再被修改；历史里有、磁盘上没有的
 *   迁移也拒绝继续（两者都会导致结构不可复现）
 * - **按方言执行迁移**：PG / SQLite 使用事务；MySQL DDL 可能部分生效，失败记入历史
 *
 * 交互层（破坏性操作确认）不在这里 —— `Diff.destructive` 由 CLI 层使用。
 */
import { SchemaDiffer } from "./differ.js";
import { describeDiff } from "./drift.js";
import { acquireProcessLock } from "./lock.js";
import { checksumOf } from "./store.js";
import type { DdlGenerator } from "./ddl.js";
import type { Diff } from "./diff/types.js";
import type { SqlExecutor } from "./executor.js";
import type { Introspector } from "./introspector.js";
import type { Schema } from "./schema/model.js";
import type { SchemaDrift } from "./drift.js";
import type {
  AppliedMigration,
  MigrationFile,
  MigrationFileStore,
  MigrationHistoryStore,
} from "./store.js";

export type { SqlExecutor } from "./executor.js";
export type { MigrationFile } from "./store.js";

export interface MigratorOptions {
  /** 磁盘迁移文件 */
  readonly files: MigrationFileStore;
  /** 数据库迁移历史 */
  readonly history: MigrationHistoryStore;
  /** 语句执行 + 数据库锁 */
  readonly executor: SqlExecutor;
  /** 现状读取（diff 的 from 侧） */
  readonly introspector: Introspector;
  /** diff → 方言 SQL */
  readonly ddl: DdlGenerator;
  /** 从模型推导的目标 schema（ts-grm 侧提供，diff 的 to 侧） */
  targetSchema: () => Promise<Schema>;
  /** 迁移文件目录（dev 生成新迁移时写入） */
  readonly migrationsDir: string;
  /** 进程锁文件路径（通常在项目根） */
  readonly lockPath: string;
  /** 数据库 advisory lock 的 key；默认使用固定资源名，由执行器限定数据库/schema */
  readonly lockKey?: string;
  /**
   * 破坏性变更的确认钩子。返回 false 则中止（抛 `MigrationAbortedError`）。
   * 不传 = 总是允许（程序化调用 / CI）。CLI 在这里做交互确认。
   */
  readonly confirm?: (diff: Diff) => Promise<boolean>;
  /** Optional progress events for CLI diagnostics. Consumers must not expose SQL by default. */
  readonly onProgress?: (event: MigrationProgress) => void;
  readonly driftLanguage?: "en" | "zh-CN";
}

export type MigrationProgress =
  | { readonly kind: "process-lock"; readonly path: string }
  | { readonly kind: "database-lock"; readonly key: string }
  | { readonly kind: "sql"; readonly sql: string }
  | { readonly kind: "migration-start" | "migration-applied"; readonly id: string };

/** 使用者在确认破坏性变更时选择中止 */
export class MigrationAbortedError extends Error {
  constructor() {
    super("Aborted: destructive change was not confirmed");
    this.name = "MigrationAbortedError";
  }
}

/** `deploy()` 结果 */
export interface DeployResult {
  /** 本次应用的迁移 id（按应用顺序） */
  readonly applied: ReadonlyArray<string>;
  /** 已应用过而跳过的数量 */
  readonly skipped: number;
  /** 应用后的对账结果（空 = 数据库已等于模型；详见 `src/drift.ts`） */
  readonly drift: ReadonlyArray<SchemaDrift>;
}

/** `dev()` 结果 */
export interface DevResult {
  readonly diff: Diff;
  /** 新生成的迁移 id；无变更时为 undefined */
  readonly migrationId: string | undefined;
  readonly applied: boolean;
  readonly drift: ReadonlyArray<SchemaDrift>;
}

/** `push()` 结果 */
export interface PushResult {
  readonly diff: Diff;
  readonly statements: ReadonlyArray<string>;
  readonly drift: ReadonlyArray<SchemaDrift>;
}

/** `status()` 结果 */
export interface MigrationStatus {
  readonly applied: ReadonlyArray<{
    readonly id: string;
    readonly appliedAt: Date;
    readonly failed: boolean;
  }>;
  readonly pending: ReadonlyArray<string>;
}

/** `resolve()` 的动作 */
export type ResolveAction =
  /** 标记为已应用（SQL 已经手工执行过） */
  | "applied"
  /** 清除失败记录（影响已回退，想重新应用） */
  | "rolled-back";

export interface ResolveOptions {
  readonly migration: string;
  readonly action: ResolveAction;
}

export class Migrator {
  private readonly _differ = new SchemaDiffer();

  constructor(private readonly _options: MigratorOptions) {}

  /** 应用所有未应用的迁移（deploy 路径，无交互） */
  async deploy(): Promise<DeployResult> {
    return await this._withLocks(true, async () => {
      const files = await this._options.files.listFiles();
      const applied = await this._effectiveApplied();
      this._assertNoFailed(applied);
      const appliedById = new Map(applied.map((a) => [a.id, a]));

      // 漂移检测 1：已应用的迁移内容不得再变
      for (const file of files) {
        const record = appliedById.get(file.id);
        if (record != null && record.checksum !== file.checksum) {
          throw new Error(
            `Migration "${file.id}" was applied but its file has changed (checksum mismatch): ` +
              `history ${short(record.checksum)} / disk ${short(file.checksum)}. ` +
              `Restore the applied file and create a new migration for corrections.`,
          );
        }
      }

      // 漂移检测 2：历史里有、磁盘上没有的迁移
      const fileIds = new Set(files.map((f) => f.id));
      const missing = applied.filter((a) => !fileIds.has(a.id));
      if (missing.length > 0) {
        throw new Error(
          `Applied migrations are missing from disk: ${missing.map((m) => m.id).join(", ")}. ` +
            `Restore the files or correct the migration history manually.`,
        );
      }

      const pending = files.filter((f) => !appliedById.has(f.id));
      const appliedNow: Array<string> = [];
      for (const file of pending) {
        await this._applyOne(file);
        appliedNow.push(file.id);
      }
      return {
        applied: appliedNow,
        skipped: files.length - pending.length,
        drift: await this._describeDrift(),
      };
    });
  }

  /**
   * 生成并应用新迁移（dev 路径）。
   * 与数据库无差异时不产生文件；破坏性变更的确认交给 CLI 层（`Diff.destructive`）。
   * `name` 可省略，省略时迁移只用时间戳命名。
   */
  async dev(options: { readonly name?: string }): Promise<DevResult> {
    return await this._withLocks(true, async () => {
      this._assertNoFailed(await this._effectiveApplied());
      const { diff, from, to } = await this._diffAgainstDatabase();
      if (diff.changes.length === 0) {
        return { diff, migrationId: undefined, applied: false, drift: [] };
      }
      await this._confirmIfNeeded(diff);

      const sql = toSqlFile(this._options.ddl.statements(diff, { from, to }));
      // Allocate after all existing generated timestamps, even if the clock moves backwards.
      const existing = await this._options.files.listFiles();
      let time = Date.now();
      for (const file of existing) {
        const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?(?:_|$)/.exec(file.id);
        if (match) {
          const previous = Date.UTC(
            +match[1]!, +match[2]! - 1, +match[3]!,
            +match[4]!, +match[5]!, +match[6]!, +(match[7] ?? 0),
          );
          // A legacy seconds-only ID must sort before the new ID, including its slug.
          time = Math.max(time, previous + (match[7] ? 1 : 1000));
        }
      }
      const id = generateMigrationId(new Date(time), options.name ?? "");
      const file: MigrationFile = { id, sql, checksum: checksumOf(sql), sortKey: id };

      await this._options.files.write(file);
      await this._applyOne(file);
      return { diff, migrationId: id, applied: true, drift: await this._describeDrift() };
    });
  }

  /** 无历史快速同步：diff 后直接应用，不写文件、不记历史（push 路径） */
  async push(): Promise<PushResult> {
    return await this._withLocks(false, async () => {
      const { diff, from, to } = await this._diffAgainstDatabase();
      await this._confirmIfNeeded(diff);
      const statements = this._options.ddl.statements(diff, { from, to });
      if (statements.length > 0) {
        for (const sql of statements) this._options.onProgress?.({ kind: "sql", sql });
        await this._options.executor.executeStatements(statements);
      }
      return { diff, statements, drift: await this._describeDrift() };
    });
  }

  /** 迁移状态（只读，不加锁，不改库） */
  async status(): Promise<MigrationStatus> {
    const files = await this._options.files.listFiles();
    const applied = await this._effectiveApplied();
    const appliedIds = new Set(applied.map((a) => a.id));
    return {
      applied: applied.map((a) => ({
        id: a.id,
        appliedAt: a.appliedAt,
        failed: a.failed,
      })),
      pending: files.filter((f) => !appliedIds.has(f.id)).map((f) => f.id),
    };
  }

  /**
   * 手工修正迁移状态 —— 失败后的恢复途径。
   *
   * - `applied`：记为已应用（适用于「这条 SQL 我已经手工执行过了」）
   * - `rolled-back`：清除历史记录，让它重新变成待应用（适用于「影响已回退」）
   *
   * 没有这一步，一次失败的迁移会把 deploy / dev 永久卡住 —— `_assertNoFailed`
   * 会一直拒绝，而使用者只能去手工改数据库表。
   */
  async resolve(options: ResolveOptions): Promise<void> {
    return await this._withLocks(true, async () => {
      const files = await this._options.files.listFiles();
      const file = files.find((f) => f.id === options.migration);
      if (file == null) {
        throw new Error(
          `Migration "${options.migration}" was not found in ${this._options.migrationsDir}; cannot resolve its state.`,
        );
      }
      if (options.action === "applied") {
        await this._options.history.recordApplied(file);
        return;
      }

      const updated = await this._options.history.markRolledBack(options.migration);
      if (!updated) {
        throw new Error(
          `Migration "${options.migration}" has no history record and cannot be marked rolled back.`,
        );
      }
    });
  }

  /**
   * 对账：不应用任何东西，只报告当前数据库与模型的差异。
   * 迁移之后调它，可确认数据库真的变成了模型的样子。
   */
  async checkDrift(): Promise<ReadonlyArray<SchemaDrift>> {
    return await this._describeDrift();
  }

  // ---- 内部 ----------------------------------------------------------------

  /** 再 introspect 一次并与模型对比（空 = 一致） */
  private async _describeDrift(): Promise<ReadonlyArray<SchemaDrift>> {
    return describeDiff((await this._diffAgainstDatabase()).diff, this._options.driftLanguage);
  }

  /**
   * 上次失败的迁移必须先处理：它意味着数据库可能处于半应用状态，
   * 而且失败记录的 checksum 是空的（不能被当成正常应用的迁移做漂移比较）。
   */
  private _assertNoFailed(applied: ReadonlyArray<AppliedMigration>): void {
    const failed = applied.filter((a) => a.failed);
    if (failed.length === 0) {
      return;
    }
    throw new Error(
      `Previous migration attempts failed: ${failed.map((f) => f.id).join(", ")}. ` +
        `The database may be partially changed. Inspect it, then use resolve --applied or resolve --rolled-back.`,
    );
  }

  /** 有破坏性变更时询问；使用者拒绝则中止 */
  private async _confirmIfNeeded(diff: Diff): Promise<void> {
    const { confirm } = this._options;
    if (confirm == null || diff.destructive.length === 0) {
      return;
    }
    if (!(await confirm(diff))) {
      throw new MigrationAbortedError();
    }
  }

  /** 包一层进程锁 + 数据库锁 */
  private async _withLocks<T>(
    ensureHistory: boolean,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lock = await acquireProcessLock(this._options.lockPath);
    let releaseDbLock: (() => Promise<void>) | undefined;
    try {
      this._options.onProgress?.({ kind: "process-lock", path: this._options.lockPath });
      const key = this._options.lockKey ?? "ts-grm-migrate";
      releaseDbLock = await this._options.executor.acquireMigrationLock(key);
      this._options.onProgress?.({ kind: "database-lock", key });
      if (ensureHistory) await this._options.history.ensureTable();
      return await fn();
    } finally {
      if (releaseDbLock != null) {
        await releaseDbLock().catch(() => undefined);
      }
      await lock.release();
    }
  }

  private async _applyOne(file: MigrationFile): Promise<void> {
    // A durable guard survives process death, connection loss and implicit DDL commits.
    // failed also represents an unfinished attempt: only resolve may unblock it.
    await this._options.history.markFailed(file.id, "Migration started but did not finish; inspect the database and use resolve to recover.", file.sql);
    this._options.onProgress?.({ kind: "migration-start", id: file.id });
    this._options.onProgress?.({ kind: "sql", sql: file.sql });
    try {
      let completed = false;
      await this._options.executor.executeStatements([file.sql], async (connection) => {
        await this._options.history.recordApplied(file, connection);
        completed = true;
      });
      if (!completed) throw new Error("SQL executor did not confirm migration completion");
      this._options.onProgress?.({ kind: "migration-applied", id: file.id });
    } catch (e) {
      const message = (e as Error).message;
      // 失败要留在历史里：否则下次 deploy 会以为这是全新迁移而重试
      try {
        await this._options.history.markFailed(file.id, message, failureLogs(file, message));
      } catch (historyError) {
        throw new AggregateError([e, historyError], `Migration "${file.id}" failed: ${message}; recording the failure also failed. The incomplete state remains.`);
      }
      throw new Error(`Migration "${file.id}" failed: ${message}`);
    }
  }

  /**
   * 当前「已生效」的迁移记录：**排除被标记回滚的**。
   * 被回滚的迁移重新算待应用（`resolve --rolled-back` 的语义），
   * 但它那条记录会保留下来，作为「什么时候回滚过」的审计痕迹。
   */
  private async _effectiveApplied(): Promise<ReadonlyArray<AppliedMigration>> {
    const applied = await this._options.history.listApplied();
    return applied.filter((a) => a.rolledBackAt == null);
  }

  private async _diffAgainstDatabase(): Promise<{ diff: Diff; from: Schema; to: Schema }> {
    const actual = await this._options.introspector.introspect();
    const target = await this._options.targetSchema();

    // migrate 自己的记账表不属于业务 schema，必须从现状里剔除：
    // 否则 diff 会把它当成「目标态没有的表」而生成 DROP，
    // 应用迁移时就把历史表删了（实测踩过）。
    const historyTable = this._options.history.tableName;
    const business = actual.tables.some((t) => t.name === historyTable)
      ? { tables: actual.tables.filter((t) => t.name !== historyTable) }
      : actual;

    return { diff: this._differ.diff(business, target), from: business, to: target };
  }
}

/**
 * 迁移 id：UTC 毫秒时间戳 + 名字 slug（`20260911120000000_init`）。
 * 时间戳前缀保证**字典序即时间序**，`sortKey` 直接复用它。
 */
export function generateMigrationId(now: Date, name: string): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${now.getUTCMilliseconds().toString().padStart(3, "0")}`;
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return slug === "" ? stamp : `${stamp}_${slug}`;
}

/** 语句数组 → 迁移文件内容（语句间空行分隔，统一以分号结尾） */
export function toSqlFile(statements: ReadonlyArray<string>): string {
  const body = statements
    .map((s) => {
      const trimmed = s.trimEnd();
      return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
    })
    .join("\n\n");
  return `${body}\n`;
}

function short(checksum: string): string {
  return checksum.slice(0, 12);
}

/** 失败时写进历史的可读日志（`error` 是摘要，`logs` 是详情） */
function failureLogs(file: MigrationFile, message: string): string {
  return [
    `Migration ${file.id} failed`,
    `Time: ${new Date().toISOString()}`,
    `Error: ${message}`,
    message.includes("rolled back") ? "The executor rolled back the transaction." : "Non-transactional DDL may have partially applied; inspect the database before resolving the migration.",
  ].join("\n");
}
