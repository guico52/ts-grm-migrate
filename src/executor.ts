/**
 * SQL 执行能力 —— migrator 的数据库交互面。
 *
 * 在 `SqlQueryable`（只读查询）之上补两件事：事务内执行语句、迁移互斥锁。
 * 方言实现见 `src/executor/`（目前 Postgres）。
 */
import type { SqlQueryable } from "./sql.js";

export interface SqlExecutor extends SqlQueryable {
  /**
   * 在事务中执行一组语句；任意一条失败则整体回滚，并抛出带上下文的错误。
   * 迁移是「全有或全无」的，不能留下半应用状态。
   */
  executeStatements(statements: ReadonlyArray<string>): Promise<void>;

  /**
   * 获取迁移互斥锁（PG 用 advisory lock），阻止其他 migrate 实例并发执行；
   * 返回解锁函数（幂等）。
   *
   * 与进程锁文件互补：进程锁保护本地项目（多终端），数据库锁保护同一数据库
   * （多机部署时进程锁无效）。
   */
  acquireMigrationLock(key: string): Promise<() => Promise<void>>;
}
