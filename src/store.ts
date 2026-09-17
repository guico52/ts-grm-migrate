/**
 * 迁移存储 —— 磁盘上的迁移文件 + 数据库中的应用历史。
 *
 * 对应 prisma-engines 的 `sql_migration.rs`（迁移文件）与
 * `sql_migration_persistence.rs`（数据库里的 `_prisma_migrations` 表）。
 *
 * 两个关注点分开表达（不同介质、不同故障模式）：
 * - `MigrationFileStore`：磁盘，`.sql` 文件即迁移；可读、可手工编辑
 * - `MigrationHistoryStore`：数据库 `_migrations` 表，记录已应用与失败
 *
 * 校验和（checksum）对**迁移 SQL 全文**计算，用于漂移检测：已应用的迁移若被事后
 * 修改，`deploy` 会拒绝继续（见 `src/migrator.ts`）。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { quoteIdentifier } from "./ddl.js";
import type { SqlExecutor } from "./executor.js";

/** 磁盘上的一个迁移文件（`<id>.sql`） */
export interface MigrationFile {
  /** 唯一 id，即文件名去掉 `.sql`（如 "20260911120000_init"） */
  readonly id: string;
  /** 迁移 SQL 全文（可含多条语句） */
  readonly sql: string;
  /** 内容校验和（对 sql 全文 sha256） */
  readonly checksum: string;
  /** 应用顺序（同 id，时间戳前缀保证字典序即时间序） */
  readonly sortKey: string;
}

/** 历史表中的一条记录 */
export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly rolledBackAt: Date | undefined;
  /** 上次执行失败则 true（对应 prisma 的 failed 状态 + migrate resolve） */
  readonly failed: boolean;
  /** 失败摘要（一行，便于快速判断与增删查） */
  readonly error: string | undefined;
  /** 执行日志（可读详情，成功时为 undefined） */
  readonly logs: string | undefined;
}

/** 磁盘迁移文件（读 + 写） */
export interface MigrationFileStore {
  /** 列出全部迁移文件，按 sortKey 升序 */
  listFiles(): Promise<ReadonlyArray<MigrationFile>>;
  /** 写入一个新迁移文件（dev 生成时用） */
  write(file: MigrationFile): Promise<void>;
}

/** 数据库迁移历史（读 + 写） */
export interface MigrationHistoryStore {
  /**
   * 历史表名。introspection 时必须从现状中排除它 —— 否则 diff 会把它当作
   * 「目标态里没有的表」而生成 DROP，把记账表删掉（实测踩过这个坑）。
   */
  readonly tableName: string;
  /** 建表（幂等）；首次使用前调用 */
  ensureTable(): Promise<void>;
  /** 已应用的迁移（含失败的），按应用时间升序 */
  listApplied(): Promise<ReadonlyArray<AppliedMigration>>;
  /** 记录一条成功应用 */
  recordApplied(migration: MigrationFile): Promise<void>;
  /** 标记失败（`error` 为摘要，`logs` 为可读详情）；供 resolve / 重试 */
  markFailed(id: string, error: string, logs?: string): Promise<void>;
  /**
   * 标记已回滚（`resolve --rolled-back`）：记录保留，但它重新变成「待应用」。
   * 不删记录 —— 什么时候回滚过、当时什么情况，都是有用的审计信息。
   * 返回是否命中记录（false = 该迁移没有历史记录）。
   */
  markRolledBack(id: string): Promise<boolean>;
}

/** 对迁移 SQL 全文计算校验和 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * 基于目录的迁移文件存储。
 *
 * 格式：`<id>.sql`，内容是迁移 SQL 全文。整个文件作为**一条**语句交给执行器
 * （PG 的 simple query 支持多语句），因此不做易错的语句切分；代价是迁移 SQL 里
 * 不应自行写 `begin` / `commit`（事务由执行器管理）。
 */
export class FileMigrationStore implements MigrationFileStore {
  constructor(private readonly _dir: string) {}

  async listFiles(): Promise<ReadonlyArray<MigrationFile>> {
    let entries: Array<string>;
    try {
      entries = await readdir(this._dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // 目录尚不存在 = 还没有迁移
        return [];
      }
      throw new Error(`读取迁移目录失败 "${this._dir}"：${(e as Error).message}`);
    }

    const files: Array<MigrationFile> = [];
    for (const name of entries) {
      if (!name.endsWith(".sql")) {
        continue;
      }
      const sql = await readFile(path.join(this._dir, name), "utf8");
      const id = name.slice(0, -".sql".length);
      files.push({ id, sql, checksum: checksumOf(sql), sortKey: id });
    }
    return files.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }

  async write(file: MigrationFile): Promise<void> {
    await mkdir(this._dir, { recursive: true });
    await writeFile(path.join(this._dir, `${file.id}.sql`), file.sql, "utf8");
  }
}

/** 默认历史表名（对应 prisma 的 `_prisma_migrations`） */
export const DEFAULT_HISTORY_TABLE = "_migrations";

/**
 * 基于数据库的迁移历史存储。
 * 语句为标准 SQL + 参数化查询，方言相关部分仅在时间类型上（Postgres 的 `timestamptz`）。
 */
export class DatabaseMigrationHistoryStore implements MigrationHistoryStore {
  readonly tableName: string;
  private readonly _table: string;

  constructor(
    private readonly _options: {
      readonly executor: SqlExecutor;
      readonly table?: string;
    },
  ) {
    this.tableName = _options.table ?? DEFAULT_HISTORY_TABLE;
    this._table = quoteIdentifier(this.tableName);
  }

  async ensureTable(): Promise<void> {
    await this._options.executor.executeStatements([
      `create table if not exists ${this._table} (
  id text primary key,
  checksum text not null,
  applied_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  failed boolean not null default false,
  error text,
  logs text
)`,
    ]);
    // 历史表自己的演进：`create table if not exists` 不会给已存在的表加列，
    // 所以显式幂等地补上后加的列（PG 9.6+ 支持 ADD COLUMN IF NOT EXISTS）。
    await this._options.executor.executeStatements([
      `alter table ${this._table} add column if not exists logs text`,
    ]);
  }

  async listApplied(): Promise<ReadonlyArray<AppliedMigration>> {
    const { rows } = await this._options.executor.query(
      `select id, checksum, applied_at, rolled_back_at, failed, error, logs
       from ${this._table}
       order by applied_at, id`,
    );
    return rows.map(toAppliedMigration);
  }

  async recordApplied(migration: MigrationFile): Promise<void> {
    await this._options.executor.query(
      `insert into ${this._table} (id, checksum, applied_at, rolled_back_at, failed, error, logs)
       values ($1, $2, now(), null, false, null, null)
       on conflict (id) do update
         set checksum = excluded.checksum,
             applied_at = now(),
             rolled_back_at = null,
             failed = false,
             error = null,
             logs = null`,
      [migration.id, migration.checksum],
    );
  }

  async markFailed(id: string, error: string, logs?: string): Promise<void> {
    await this._options.executor.query(
      `insert into ${this._table} (id, checksum, applied_at, failed, error, logs)
       values ($1, '', now(), true, $2, $3)
       on conflict (id) do update
         set failed = true,
             error = excluded.error,
             logs = excluded.logs`,
      [id, error, logs ?? null],
    );
  }

  async markRolledBack(id: string): Promise<boolean> {
    const { rows } = await this._options.executor.query(
      `update ${this._table}
       set rolled_back_at = now(),
           failed = false
       where id = $1
       returning id`,
      [id],
    );
    return rows.length > 0;
  }
}

function toAppliedMigration(row: Record<string, unknown>): AppliedMigration {
  return {
    id: asString(row["id"]),
    checksum: asString(row["checksum"]),
    appliedAt: toDate(row["applied_at"]),
    rolledBackAt: row["rolled_back_at"] == null ? undefined : toDate(row["rolled_back_at"]),
    failed: row["failed"] === true,
    error: row["error"] == null ? undefined : asString(row["error"]),
    logs: row["logs"] == null ? undefined : asString(row["logs"]),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
