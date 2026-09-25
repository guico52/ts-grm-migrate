/**
 * ts-grm-migrate — ts-grm 的 schema 迁移引擎。
 *
 * 分层（对应 prisma-engines 的目录结构）：
 * - schema/model.ts   统一比较形状（继承 ts-grm 原生定义）
 * - schema/adapter.ts TableDef[] → Schema（目标态适配）
 * - snapshot.ts       快照序列化 / 反序列化 / 校验
 * - differ.ts         diff 引擎                (sql_schema_differ.rs)
 * - introspector.ts   数据库现状读取            (introspection.rs + sql-schema-describer)
 * - ddl.ts            DDL 生成（方言）          (libs/sql-ddl + sql_renderer.rs)
 * - store.ts          迁移文件 + 历史表         (sql_migration.rs / sql_migration_persistence.rs)
 * - migrator.ts       迁移应用器                (apply_migration.rs / apply_migrations.rs)
 */
export type {
  Schema,
  Table,
  Column,
  Constraint,
  Index,
  PrimaryKeyConstraint,
  UniqueConstraint,
  ForeignKeyConstraint,
  CheckConstraint,
  OnDelete,
} from "./schema/model.js";
export { emptySchema } from "./schema/model.js";
export { tableDefsToSchema } from "./schema/adapter.js";
export type { SchemaDriver } from "./schema/adapter.js";
export {
  toSnapshot,
  fromSnapshot,
  isSchema,
  SNAPSHOT_FORMAT_VERSION,
} from "./snapshot.js";
export type { SchemaSnapshot } from "./snapshot.js";
export type {
  Diff,
  Change,
  AlterTable,
  ColumnChange,
  ConstraintChange,
  IndexChange,
  CreateTable,
  DropTable,
  DestructiveChange,
} from "./diff/types.js";
export type { Differ } from "./differ.js";
export { SchemaDiffer } from "./differ.js";
export type { SqlQueryable } from "./sql.js";
export type { SqlExecutor } from "./executor.js";
export { PostgresSqlExecutor } from "./executor/postgres.js";
export type { PgClientLike, PgPoolLike } from "./executor/postgres.js";
export { acquireProcessLock } from "./lock.js";
export type { ProcessLock } from "./lock.js";
export type { Introspector, Dialect } from "./introspector.js";
// ---- 方言注册表（哪些方言、上游由谁提供、实现到哪一步）------------------
export { DIALECTS, DIALECT_NAMES, IMPLEMENTED_DIALECT_NAMES, dialectInfo } from "./dialect.js";
export type { DialectInfo } from "./dialect.js";
export { PostgresIntrospector } from "./introspector/postgres.js";
export type { PostgresIntrospectorOptions } from "./introspector/postgres.js";
export type { DdlGenerator, DdlGeneratorOptions } from "./ddl.js";
export { PostgresDdlGenerator } from "./ddl/postgres.js";
export { SqliteDdlGenerator } from "./ddl/sqlite.js";
export {
  checksumOf,
  DatabaseMigrationHistoryStore,
  DEFAULT_HISTORY_TABLE,
  FileMigrationStore,
} from "./store.js";
export type {
  AppliedMigration,
  MigrationFile,
  MigrationFileStore,
  MigrationHistoryStore,
} from "./store.js";
export { generateMigrationId, Migrator, MigrationAbortedError, toSqlFile } from "./migrator.js";
export type {
  DeployResult,
  DevResult,
  MigrationStatus,
  MigratorOptions,
  MigrationProgress,
  PushResult,
  ResolveAction,
  ResolveOptions,
} from "./migrator.js";

// ---- 配置与运行时（CLI 与程序化调用共用同一条组装链）--------------------
export { CONFIG_FILENAMES, defineConfig, loadConfig } from "./config.js";
export type {
  DatabaseConfig,
  DialectName,
  LoadedConfig,
  MigrateConfig,
  OutputLanguage,
} from "./config.js";
export { createRuntime, DEFAULT_LOCK_PATH, DEFAULT_MIGRATIONS_DIR } from "./runtime.js";
export type { Runtime, RuntimeOptions } from "./runtime.js";

// ---- 对账（迁移后确认数据库 == 模型）----------------------------------------
export { abnormalDrift, describeDiff } from "./drift.js";
export type { SchemaDrift } from "./drift.js";

// ---- CLI ------------------------------------------------------------------
export { parseArgs, run } from "./cli.js";
export type { ParsedArgs, RunOptions } from "./cli/types.js";

export { MysqlDdlGenerator } from "./ddl/mysql.js";
export { MysqlIntrospector } from "./introspector/mysql.js";
export { MysqlSqlExecutor } from "./executor/mysql.js";
export type { MysqlPoolLike, MysqlConnectionLike } from "./executor/mysql.js";
export type { DdlContext } from "./ddl.js";

export { SqlServerDdlGenerator } from "./ddl/sqlserver.js";
export { SqlServerIntrospector } from "./introspector/sqlserver.js";
export { SqlServerSqlExecutor } from "./executor/sqlserver.js";

export { OracleDdlGenerator } from "./ddl/oracle.js";
export { OracleIntrospector } from "./introspector/oracle.js";
export { OracleSqlExecutor } from "./executor/oracle.js";
export { ServerMigrationHistoryStore } from "./server/history.js";
export { ServerSql } from "./server/sql.js";

export type { SqlServerSession, SqlServerRequestLike } from "./executor/sqlserver.js";
export type { OracleSession } from "./executor/oracle.js";
