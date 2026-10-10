import { diagnostic, asError } from "../diagnostics/error.js";
/**
 * Postgres 版 `SqlExecutor`。
 *
 * 只依赖结构接口（`PgPoolLike` / `PgClientLike`），不 import pg 的类型 ——
 * migrate 核心因此不需要把 pg 作为运行时依赖，调用方传自己的 Pool 实例即可。
 */
import type { MigrationCompletion, SqlExecutor } from "../executor.js";

/** pg 的 Pool（只声明用到的部分） */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }>;
}

/** pg 的连接 */
export interface PgClientLike {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }>;
  release(error?: Error | boolean): void;
}

export class PostgresSqlExecutor implements SqlExecutor {
  private _locked: PgClientLike | undefined;
  private _acquiring = false;
  constructor(private readonly _pool: PgPoolLike) {}

  async query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    return await (this._locked ?? this._pool).query(sql, params);
  }

  async executeStatements(statements: ReadonlyArray<string>, complete?: MigrationCompletion): Promise<void> {
    const client = this._locked ?? await this._pool.connect();
    const owned = client !== this._locked;
    let broken: Error | undefined;
    try {
      await client.query("begin");
      for (const sql of statements) {
        await client.query(sql);
      }
      await complete?.(client);
      await client.query("commit");
    } catch (e) {
      try { await client.query("rollback"); } catch (rollbackError) {
        broken = asError(rollbackError);
        throw diagnostic("executor_postgres_rollback", asError(e), broken);
      }
      throw diagnostic("executor_postgres_1", asError(e));
    } finally {
      if (owned) client.release(broken);
    }
  }

  async acquireMigrationLock(key: string): Promise<() => Promise<void>> {
    if (this._locked || this._acquiring) throw diagnostic("lock_busy", key);
    this._acquiring = true;
    // The same session owns the lock and all migration work.
    let client: PgClientLike;
    try {
      client = await this._pool.connect();
    } catch (error) {
      this._acquiring = false;
      throw error;
    }
    try {
      // **必须先设锁超时**：`pg_advisory_lock` 默认无限等待，一旦锁被别的会话
      // 持有（残留连接、异常退出的实例）就会永久挂住，表现为测试莫名超时。
      // Prisma 同样带 ADVISORY_LOCK_TIMEOUT。
      await client.query("set lock_timeout = '10s'");
      await client.query("select pg_advisory_lock(hashtext(current_database()), hashtext(current_schema() || ':' || $1))", [key]);
      await client.query("reset lock_timeout");
      this._locked = client;
    } catch (e) {
      await client.query("reset lock_timeout").catch(() => undefined);
      client.release(asError(e));
      throw diagnostic("executor_postgres_2", asError(e));
    } finally {
      this._acquiring = false;
    }
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      this._locked = undefined;
      try {
        const result = await client.query("select pg_advisory_unlock(hashtext(current_database()), hashtext(current_schema() || ':' || $1)) as unlocked", [key]);
        if (result.rows[0]?.unlocked !== true) throw diagnostic("lock_busy", key);
        client.release();
      } catch (error) {
        client.release(asError(error));
        throw error;
      }
    };
  }
}
