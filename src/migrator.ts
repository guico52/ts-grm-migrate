/**
 * Migrator —— 迁移应用器：文件扫描 -> 与历史比对 -> 按序执行 -> 记录。
 *
 * 对应 prisma-engines 的 `apply_migration.rs` 与命令层 `apply_migrations.rs`。
 *
 * 可靠性设计（TODO，尚未实现）：
 * - PG：每个迁移一个事务（DDL 可回滚），失败 ROLLBACK 后标记 failed；
 * - 并发防护：advisory lock（PG 的 pg_advisory_lock），多实例部署防并发迁移；
 * - 漂移检测：已应用迁移的 checksum 与磁盘文件不一致 -> 拒绝继续；
 * - shadow database：应用前在临时库试跑验证（PG 下也可用 BEGIN+ROLLBACK 做 dry-run）。
 */
import type { MigrationStore, MigrationFile } from "./store";
import type { Schema } from "./schema/model";
import type { DdlGenerator } from "./ddl";

export interface SqlExecutor {
  /** 在事务中执行一组语句；任意一条失败则整体回滚并抛出带上下文错误 */
  executeStatements(statements: ReadonlyArray<string>): Promise<void>;

  /** PG 事务级 advisory lock；返回解锁函数 */
  acquireMigrationLock(id: string): Promise<() => Promise<void>>;
}

export interface MigratorOptions {
  readonly store: MigrationStore;
  readonly ddl: DdlGenerator;
  readonly executor: SqlExecutor;
  /** 从模型推导出的目标 schema（ts-grm 侧提供） */
  targetSchema: () => Promise<Schema>;
}

export class Migrator {
  constructor(private readonly _options: MigratorOptions) {}

  /** 应用所有未应用的迁移（deploy 路径，无交互） */
  async deploy(): Promise<void> {
    throw new Error("Migrator.deploy 尚未实现 —— 起点骨架，下一步实现");
  }

  /** 生成并应用新迁移（dev 路径，先算 diff 再询问，本起点未含交互层） */
  async dev(): Promise<void> {
    throw new Error("Migrator.dev 尚未实现 —— 起点骨架，下一步实现");
  }
}

export type { MigrationFile };
