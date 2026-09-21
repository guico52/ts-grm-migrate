import { createHash } from "node:crypto";
import type { SqlExecutor } from "../executor.js";

export interface MysqlConnectionLike {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<readonly [unknown, unknown]>;
  execute(sql: string, params: ReadonlyArray<unknown>): Promise<readonly [unknown, unknown]>;
  release(): void;
  destroy(): void;
}
export interface MysqlPoolLike {
  getConnection(): Promise<MysqlConnectionLike>;
}

/**
 * DDL implicitly commits in MySQL. Never report that a failed migration was rolled back.
 * Keep the advisory lock and all migration work on the same session: loss of the session
 * must abort the migration instead of continuing on another pooled connection.
 * @see https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html
 * @see https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html
 */
export class MysqlSqlExecutor implements SqlExecutor {
  private _locked: MysqlConnectionLike | undefined;
  constructor(private readonly _pool: MysqlPoolLike, private readonly _lockTimeout = 10) {}

  private async _prepare(connection: MysqlConnectionLike): Promise<void> {
    // Preserve server modes (especially STRICT_TRANS_TABLES) and make string escaping deterministic.
    await connection.query("set session sql_mode = concat_ws(',', nullif(@@sql_mode, ''), 'NO_BACKSLASH_ESCAPES')");
  }

  private async _withConnection<T>(fn: (connection: MysqlConnectionLike) => Promise<T>): Promise<T> {
    if (this._locked) return await fn(this._locked);
    const connection = await this._pool.getConnection();
    try {
      await this._prepare(connection);
      return await fn(connection);
    } finally {
      connection.release();
    }
  }

  async query(sql: string, params?: ReadonlyArray<unknown>): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    return await this._withConnection(async (connection) => {
      const [result] = params?.length
        ? await connection.execute(sql, params)
        : await connection.query(sql);
      return { rows: Array.isArray(result) ? result as Array<Record<string, unknown>> : [] };
    });
  }

  async executeStatements(statements: ReadonlyArray<string>): Promise<void> {
    await this._withConnection(async (connection) => {
      try {
        for (const sql of statements) await connection.query(sql);
      } catch (e) {
        throw new Error(`MySQL 语句执行失败：${(e as Error).message}。DDL 会隐式提交，之前成功的语句可能已生效；请检查数据库后使用 resolve 修正状态。`);
      }
    });
  }

  async acquireMigrationLock(_key: string): Promise<() => Promise<void>> {
    if (this._locked) throw new Error("当前 MySQL 执行器已持有迁移锁");
    const connection = await this._pool.getConnection();
    let name: string;
    try {
      await this._prepare(connection);
      const [result] = await connection.query("select database() as db");
      const db = (result as Array<{ db: string | null }>)[0]?.db;
      if (!db) throw new Error("MySQL 连接必须指定 database");
      // Lock identity is the database, not a machine-local path.
      name = `tgm:${createHash("sha256").update(db).digest("hex").slice(0, 60)}`;
      const [rows] = await connection.query(`select get_lock('${name}', ${this._lockTimeout}) as acquired`);
      if (Number((rows as Array<{ acquired: unknown }>)[0]?.acquired) !== 1) {
        throw new Error(`获取 MySQL 迁移锁失败（等待 ${this._lockTimeout}s）`);
      }
      this._locked = connection;
    } catch (e) {
      connection.destroy();
      throw e;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this._locked = undefined;
      try {
        await connection.query(`select release_lock('${name}')`);
        connection.release();
      } catch {
        connection.destroy();
      }
    };
  }
}

