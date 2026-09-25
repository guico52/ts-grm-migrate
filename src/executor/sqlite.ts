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
 * 2. **没有 advisory lock**，`acquireMigrationLock` 是 no-op。SQLite 是嵌入式
 *    单文件库，不存在「多机同时连一个库」的部署形态（它的并发模型是本机文件锁）；
 *    本地多进程由进程锁文件挡住，同一文件的并发写由 SQLite 自身串行化。
 *    这是刻意的取舍，不是遗漏。
 */
import type { MigrationCompletion, SqlExecutor } from "../executor.js";

/** better-sqlite3 的 Database（只声明用到的部分） */
export interface SqliteDatabaseLike {
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
  constructor(private readonly _database: SqliteDatabaseLike) {}

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
      throw new Error(`Statement failed (transaction rolled back): ${(e as Error).message}`);
    }
  }

  async acquireMigrationLock(_key: string): Promise<() => Promise<void>> {
    // 见文件头注释第 2 点：SQLite 没有 advisory lock，也不需要
    return async () => {
      // no-op
    };
  }
}
