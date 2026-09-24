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
import { ServerMigrationHistoryStore } from "./server/history.js";
import { ServerSql } from "./server/sql.js";
import { quoteMysqlIdentifier } from "./mysql/sql.js";
import { quoteIdentifier } from "./ddl.js";
import type { SqlQueryable } from "./sql.js";
import type { SqlExecutor } from "./executor.js";
import type { DialectName } from "./dialect.js";

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
  /** 执行未完成或失败时为 true；执行前持久化，成功提交后清除（migrate resolve 可恢复） */
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
  /** 记录成功；提供 connection 时必须使用该事务连接，不能转交连接池。 */
  recordApplied(migration: MigrationFile, connection?: SqlQueryable): Promise<void>;
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
 * 格式：`<id>.sql`，文件全文交给执行器。PG / MySQL / SQL Server 执行批次，
 * Oracle 执行器负责识别 SQL 语句边界。文件不要自行写 begin / commit：事务由执行器管理。
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
    await writeFile(path.join(this._dir, `${file.id}.sql`), file.sql, { encoding: "utf8", flag: "wx" });
  }
}

/** 默认历史表名（对应 prisma 的 `_prisma_migrations`） */
export const DEFAULT_HISTORY_TABLE = "_migrations";

/**
 * 基于数据库的迁移历史存储。
 *
 * 语句是标准 SQL，方言差异集中在三处：时间类型（PG `timestamptz` / SQLite `text`）、
 * 当前时间表达式（`now()` / `current_timestamp`）、以及参数占位符（`$n` / `?`）。
 * 另有 SQLite 不支持 `alter table ... add column if not exists`，改查 catalog 实现幂等。
 */
export class DatabaseMigrationHistoryStore implements MigrationHistoryStore {
  readonly tableName: string;
  private readonly _table: string;

  private readonly _dialect: DialectName;
  private readonly _server?: ServerMigrationHistoryStore;

  constructor(
    private readonly _options: {
      readonly executor: SqlExecutor;
      readonly table?: string;
      /** 方言，默认 postgres（用于时间类型、now() 与占位符） */
      readonly dialect?: DialectName;
      /** SQL Server defaults to dbo; Oracle requires an explicit schema. */
      readonly schema?: string;
    },
  ) {
    this.tableName = _options.table ?? DEFAULT_HISTORY_TABLE;
    this._dialect = _options.dialect ?? "postgres";
    if (this._dialect === "mssql" || this._dialect === "oracle") {
      if (this._dialect === "oracle" && !_options.schema) throw new Error("Oracle 历史表需要 schema");
      this._server = new ServerMigrationHistoryStore(_options.executor, new ServerSql(this._dialect, _options.schema ?? "dbo"), this.tableName);
    }
    this._table = this._dialect === "mysql" ? quoteMysqlIdentifier(this.tableName) : quoteIdentifier(this.tableName);
  }

  /** 当前时间表达式：PG 用 now()，SQLite 用 current_timestamp */
  private get _now(): string {
    return this._dialect === "postgres" ? "now()" : this._dialect === "mysql" ? "current_timestamp(3)" : "current_timestamp";
  }

  /** 参数占位符：PG 是 $n，SQLite 是 ?（位置绑定，顺序一致） */
  private _ph(index: number): string {
    return this._dialect === "postgres" ? `$${index}` : "?";
  }

  async ensureTable(): Promise<void> {
    if (this._server) return this._server.ensureTable();
    const ts = this._dialect === "postgres" ? "timestamptz" : this._dialect === "mysql" ? "datetime(3)" : "text";
    await this._options.executor.executeStatements([
      `create table if not exists ${this._table} (
  id ${this._dialect === "mysql" ? "varchar(255) collate utf8mb4_bin" : "text"} primary key,
  checksum text not null,
  applied_at ${ts} not null default ${this._now},
  rolled_back_at ${ts},
  failed boolean not null default false,
  error text,
  logs text
)`,
    ]);
    // 历史表自己的演进：`create table if not exists` 不会给已存在的表加列，
    // 所以显式幂等地补上后加的列。
    await this._addColumnIfMissing("logs", "text");
  }

  /**
   * 幂等补列。
   * PG 9.6+ 有 `add column if not exists`；SQLite 没有该语法，改查 catalog
   * （`pragma_table_info` 表值函数，SQLite 3.16+）。
   */
  private async _addColumnIfMissing(column: string, definition: string): Promise<void> {
    if (this._dialect === "postgres") {
      await this._options.executor.executeStatements([
        `alter table ${this._table} add column if not exists ${column} ${definition}`,
      ]);
      return;
    }
    const { rows } = this._dialect === "mysql"
      ? await this._options.executor.query(
          "select COLUMN_NAME as name from information_schema.COLUMNS where TABLE_SCHEMA = database() and TABLE_NAME = ?", [this.tableName])
      : await this._options.executor.query(`select name from pragma_table_info(${quoteLiteral(this.tableName)})`);
    if (rows.some((r) => asString(r["name"]) === column)) {
      return;
    }
    await this._options.executor.executeStatements([
      `alter table ${this._table} add column ${column} ${definition}`,
    ]);
  }

  async listApplied(): Promise<ReadonlyArray<AppliedMigration>> {
    if (this._server) return this._server.listApplied();
    let rows: ReadonlyArray<Record<string, unknown>>;
    try {
      ({ rows } = await this._options.executor.query(
        `select id, checksum, applied_at, rolled_back_at, failed, error, logs
         from ${this._table} order by applied_at, id`,
      ));
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if ((this._dialect === "postgres" && e.code === "42P01") ||
          (this._dialect === "mysql" && e.code === "ER_NO_SUCH_TABLE") ||
          (this._dialect === "sqlite" && e.code === "SQLITE_ERROR" && e.message === `no such table: ${this.tableName}`)) return [];
      throw error;
    }
    return rows.map(toAppliedMigration);
  }

  async recordApplied(migration: MigrationFile, connection: SqlQueryable = this._options.executor): Promise<void> {
    if (this._server) return this._server.recordApplied(migration, connection);
    await connection.query(
      `insert into ${this._table} (id, checksum, applied_at, rolled_back_at, failed, error, logs)
       values (${this._ph(1)}, ${this._ph(2)}, ${this._now}, null, false, null, null)
       ${this._dialect === "mysql"
         ? "on duplicate key update checksum = values(checksum),"
         : "on conflict (id) do update set checksum = excluded.checksum,"}
             applied_at = ${this._now},
             rolled_back_at = null,
             failed = false,
             error = null,
             logs = null`,
      [migration.id, migration.checksum],
    );
  }

  async markFailed(id: string, error: string, logs?: string): Promise<void> {
    if (this._server) return this._server.markFailed(id, error, logs);
    await this._options.executor.query(
      `insert into ${this._table} (id, checksum, applied_at, failed, error, logs)
       values (${this._ph(1)}, '', ${this._now}, true, ${this._ph(2)}, ${this._ph(3)})
       ${this._dialect === "mysql"
         ? "on duplicate key update failed = true, rolled_back_at = null, error = values(error), logs = values(logs)"
         : "on conflict (id) do update set failed = true, rolled_back_at = null, error = excluded.error, logs = excluded.logs"}`,
      [id, error, logs ?? null],
    );
  }

  async markRolledBack(id: string): Promise<boolean> {
    if (this._server) return this._server.markRolledBack(id);
    if (this._dialect === "mysql") {
      const { rows } = await this._options.executor.query(`select id from ${this._table} where id = ?`, [id]);
      if (rows.length === 0) return false;
      await this._options.executor.query(`update ${this._table} set rolled_back_at = ${this._now}, failed = false where id = ?`, [id]);
      return true;
    }
    const { rows } = await this._options.executor.query(
      `update ${this._table}
       set rolled_back_at = ${this._now},
           failed = false
       where id = ${this._ph(1)}
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
    // SQLite 没有布尔类型，存的是 1/0；PG 返回 boolean
    failed: row["failed"] === true || Number(row["failed"]) === 1,
    error: row["error"] == null ? undefined : asString(row["error"]),
    logs: row["logs"] == null ? undefined : asString(row["logs"]),
  };
}

/** SQL 字符串字面量（用于 pragma 之类不能参数化的位置） */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
