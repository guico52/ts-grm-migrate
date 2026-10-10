import { realpath } from "node:fs/promises";
import { acquireProcessLock } from "../lock.js";
import { diagnostic, asError } from "../diagnostics/error.js";
/**
 * SQLite 版 `SqlExecutor`。
 *
 * 只依赖结构接口（`SqliteDatabaseLike`），不 import better-sqlite3 的类型 ——
 * migrate 核心因此不需要把 better-sqlite3 作为运行时依赖，调用方传自己的
 * Database 实例即可。
 *
 * 与 Postgres 版有两处差异：
 *
 * 1. better-sqlite3 是**同步 API**，这里包装成异步以满足 `SqlExecutor`。
 * 2. File databases use a canonical-path process lease for the whole operation,
 *    including introspection and planning. Memory databases need no external lock.
 *    Programmatic callers should pass the file path as the second constructor argument.
 */
import type { MigrationCompletion, SqlExecutor } from "../executor.js";

/** better-sqlite3 的 Database（只声明用到的部分） */
export interface SqliteDatabaseLike {
  /** Native better-sqlite3 exposes its database filename. */
  readonly name?: string;
  prepare(sql: string): SqliteStatementLike;
  /** 执行（可含多条语句的）SQL 文本，不返回行 */
  exec(sql: string): unknown;
}

/** better-sqlite3 的 Statement（只声明用到的部分） */
export interface SqliteStatementLike {
  /** 该语句是否返回行（better-sqlite3 的 Statement.reader） */
  readonly reader: boolean;
  all(...params: ReadonlyArray<unknown>): Array<Record<string, unknown>>;
  run(...params: ReadonlyArray<unknown>): unknown;
}

export class SqliteSqlExecutor implements SqlExecutor {
  constructor(private readonly _database: SqliteDatabaseLike, private readonly _file: string | undefined = _database.name) {}

  async query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    // pragma 之类的语句也走 prepare，better-sqlite3 同样支持
    const statement = this._database.prepare(sql);
    // 不返回行的语句（insert / update / ddl）用 `all()` 会抛
    // "This statement does not return data"，必须改用 `run()`
    if (!statement.reader) {
      statement.run(...(params ?? []));
      return { rows: [] };
    }
    return { rows: statement.all(...(params ?? [])) };
  }

  async executeStatements(statements: ReadonlyArray<string>, complete?: MigrationCompletion): Promise<void> {
    this._database.exec("begin");
    try {
      for (const sql of statements) {
        // exec 而非 prepare：迁移文件里往往是整段 SQL 文本（可能含多条语句）
        this._database.exec(sql);
      }
      await complete?.(this);
      this._database.exec("commit");
    } catch (e) {
      try {
        this._database.exec("rollback");
      } catch {
        // 回滚失败不掩盖主流程真正的错误
      }
      throw diagnostic("executor_sqlite_1", asError(e));
    }
  }

  async acquireMigrationLock(_key: string): Promise<() => Promise<void>> {
    if (!this._file || this._file === ":memory:") return async () => {};
    const file = await realpath(this._file);
    const lock = await acquireProcessLock(`${file}.tgm-lock`);
    return () => lock.release();
  }
}
