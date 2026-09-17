/**
 * Postgres 版 `SqlExecutor`。
 *
 * 只依赖结构接口（`PgPoolLike` / `PgClientLike`），不 import pg 的类型 ——
 * migrate 核心因此不需要把 pg 作为运行时依赖，调用方传自己的 Pool 实例即可。
 */
import type { SqlExecutor } from "../executor.js";

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
  release(): void;
}

export class PostgresSqlExecutor implements SqlExecutor {
  constructor(private readonly _pool: PgPoolLike) {}

  async query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    return await this._pool.query(sql, params);
  }

  async executeStatements(statements: ReadonlyArray<string>): Promise<void> {
    const client = await this._pool.connect();
    try {
      await client.query("begin");
      for (const sql of statements) {
        await client.query(sql);
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw new Error(`语句执行失败（已回滚）：${(e as Error).message}`);
    } finally {
      client.release();
    }
  }

  async acquireMigrationLock(key: string): Promise<() => Promise<void>> {
    // advisory lock 是会话级：必须占用同一条连接，直到解锁或连接断开
    const client = await this._pool.connect();
    try {
      // **必须先设锁超时**：`pg_advisory_lock` 默认无限等待，一旦锁被别的会话
      // 持有（残留连接、异常退出的实例）就会永久挂住，表现为测试莫名超时。
      // Prisma 同样带 ADVISORY_LOCK_TIMEOUT。
      await client.query("set lock_timeout = '10s'");
      await client.query("select pg_advisory_lock(hashtext($1)::bigint)", [key]);
    } catch (e) {
      await client.query("reset lock_timeout").catch(() => undefined);
      client.release();
      throw new Error(
        `获取迁移锁失败（等待超过 10s）：${(e as Error).message}`,
      );
    }
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]);
      } catch {
        // 解锁失败通常意味着连接已断（锁会随会话结束自动释放），
        // 不掩盖主流程里真正的错误
      } finally {
        // 归还前复位，避免这条连接的下一个使用者继承 lock_timeout
        await client.query("reset lock_timeout").catch(() => undefined);
        client.release();
      }
    };
  }
}
