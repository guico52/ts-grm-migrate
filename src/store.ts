/**
 * 迁移历史 —— 迁移文件的存储与已应用记录。
 *
 * 对应 prisma-engines 的 `sql_migration.rs` / `sql_migration_persistence.rs`
 * （即数据库里的 `_prisma_migrations` 表 + 磁盘上的迁移文件目录）。
 *
 * 本起点先定义数据模型，存储实现（磁盘 + 数据库表）留待下一步。
 */

/** 磁盘上的一个迁移文件 */
export interface MigrationFile {
  /** 迁移目录下唯一 id（如时间戳命名 "202608130001_init"） */
  readonly id: string;
  /** 迁移 SQL 内容（按序语句数组） */
  readonly statements: ReadonlyArray<string>;
  /** 内容校验和，用于检测已应用迁移被篡改（漂移检测） */
  readonly checksum: string;
  /** 应用顺序（时间戳解析出的序号） */
  readonly sortKey: string;
}

/** 历史表中的一条已应用记录 */
export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly rolledBackAt: Date | undefined;
  /** 上次执行失败则置 true（对应 prisma 的 failed 状态 + migrate resolve） */
  readonly failed: boolean;
}

export interface MigrationStore {
  /** 列出磁盘上的全部迁移文件（按 sortKey 排序） */
  listFiles(): Promise<ReadonlyArray<MigrationFile>>;

  /** 读取历史表中已应用的迁移 */
  listApplied(): Promise<ReadonlyArray<AppliedMigration>>;

  /** 记录一条已应用记录 */
  recordApplied(migration: MigrationFile): Promise<void>;

  /** 标记失败（含失败原因），供 resolve/重试 */
  markFailed(id: string, error: string): Promise<void>;
}
