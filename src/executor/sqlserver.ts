import { createHash } from "node:crypto";
import type { MigrationCompletion, SqlExecutor } from "../executor.js";

export interface SqlServerRequestLike {
  input(name: string, value: unknown): SqlServerRequestLike;
  batch(
    sql: string,
  ): Promise<{ readonly recordset?: ReadonlyArray<Record<string, unknown>> }>;
  query(
    sql: string,
  ): Promise<{ readonly recordset?: ReadonlyArray<Record<string, unknown>> }>;
}
/** Request factory bound to one physical session, never to the unpinned pool. */
export interface SqlServerSession {
  request(): SqlServerRequestLike;
}

/**
 * Transactional DDL and session-owned application locks use the same pinned connection.
 * @see https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql
 */
export class SqlServerSqlExecutor implements SqlExecutor {
  private _lockHeld = false;
  constructor(
    private readonly _session: SqlServerSession,
    private readonly _schema = "dbo",
    private readonly _lockTimeoutMs = 10_000,
  ) {}

  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    const request = this._session.request();
    params.forEach((value, index) => request.input(`p${index + 1}`, value));
    return { rows: (await request.query(sql)).recordset ?? [] };
  }

  async executeStatements(statements: ReadonlyArray<string>, complete?: MigrationCompletion): Promise<void> {
    await this._session.request().batch("begin transaction");
    try {
      for (const sql of statements) await this._session.request().batch(sql);
      await complete?.(this);
      await this._session.request().batch("commit transaction");
    } catch (e) {
      try {
        await this._session
          .request()
          .batch("if @@trancount > 0 rollback transaction");
      } catch {
        throw new Error(
          `SQL Server 执行失败且无法确认回滚：${(e as Error).message}`,
        );
      }
      throw new Error(
        `SQL Server 语句执行失败（事务已回滚）：${(e as Error).message}`,
      );
    }
  }

  async acquireMigrationLock(_key: string): Promise<() => Promise<void>> {
    if (this._lockHeld) throw new Error("当前 SQL Server 执行器已持有迁移锁");
    // App locks are database-scoped. The schema, not a local filesystem path, identifies the resource.
    const name = `ts-grm:${createHash("sha256").update(this._schema).digest("hex")}`;
    const { rows } = await this.query(
      `declare @r int;
      exec @r = sys.sp_getapplock @Resource=@p1, @LockMode='Exclusive', @LockOwner='Session', @LockTimeout=@p2;
      select @r as result`,
      [name, this._lockTimeoutMs],
    );
    if (rows[0]?.result == null || Number(rows[0].result) < 0)
      throw new Error("获取 SQL Server 迁移锁失败");
    this._lockHeld = true;
    return async () => {
      if (!this._lockHeld) return;
      await this.query(
        "exec sys.sp_releaseapplock @Resource=@p1, @LockOwner='Session'",
        [name],
      );
      this._lockHeld = false;
    };
  }
}
