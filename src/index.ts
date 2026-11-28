/**
 * ts-grm-migrate — ts-grm 的 schema 迁移引擎。
 *
 * 分层（对应 prisma-engines 的目录结构）：
 * - schema/model.ts   统一比较形状（继承 ts-grm 原生定义）
 * - schema/adapter.ts TableDef[] → Schema（目标态适配）
 * - schema/patches.ts 列级扩展元数据（ts-grm-patches 的 autoIncrement / default）
 * - snapshot.ts       快照序列化 / 反序列化 / 校验
 * - differ.ts         diff 引擎                (sql_schema_differ.rs)
 * - introspector.ts   数据库现状读取            (introspection.rs + sql-schema-describer)
 * - ddl.ts            DDL 生成（方言）          (libs/sql-ddl + sql_renderer.rs)
 * - store.ts          迁移文件 + 历史表         (sql_migration.rs / sql_migration_persistence.rs)
 * - migrator.ts       迁移应用器                (apply_migration.rs / apply_migrations.rs)
 */

export type { ParsedArgs, RunOptions } from './cli/types.js';
// ---- CLI ------------------------------------------------------------------
export { parseArgs, run } from './cli.js';
export type {
  DatabaseConfig,
  DialectName,
  LoadedConfig,
  MigrateConfig,
  OutputLanguage,
  SeedConfig,
} from './config.js';
// ---- 配置与运行时（CLI 与程序化调用共用同一条组装链）--------------------
export { CONFIG_FILENAMES, defineConfig, loadConfig } from './config.js';
export { MysqlDdlGenerator } from './ddl/mysql.js';
export { OracleDdlGenerator } from './ddl/oracle.js';
export { PostgresDdlGenerator } from './ddl/postgres.js';
export { SqliteDdlGenerator } from './ddl/sqlite.js';
export { SqlServerDdlGenerator } from './ddl/sqlserver.js';
export type { DdlContext, DdlGenerator, DdlGeneratorOptions } from './ddl.js';
export type { DialectInfo } from './dialect.js';
// ---- 方言注册表（哪些方言、上游由谁提供、实现到哪一步）------------------
export { DIALECT_NAMES, DIALECTS, dialectInfo, IMPLEMENTED_DIALECT_NAMES } from './dialect.js';
export type {
  AlterTable,
  Change,
  ColumnChange,
  ConstraintChange,
  CreateTable,
  DestructiveChange,
  Diff,
  DropTable,
  IndexChange,
} from './diff/types.js';
export type { Differ } from './differ.js';
export { SchemaDiffer } from './differ.js';
export type { SchemaDrift } from './drift.js';
// ---- 对账（迁移后确认数据库 == 模型）----------------------------------------
export { abnormalDrift, describeDiff } from './drift.js';
export type { MysqlConnectionLike, MysqlPoolLike } from './executor/mysql.js';
export { MysqlSqlExecutor } from './executor/mysql.js';
export type { OracleSession } from './executor/oracle.js';
export { OracleSqlExecutor } from './executor/oracle.js';
export type { PgClientLike, PgPoolLike } from './executor/postgres.js';
export { PostgresSqlExecutor } from './executor/postgres.js';
export { SqliteSqlExecutor } from './executor/sqlite.js';
export type { SqlServerRequestLike, SqlServerSession } from './executor/sqlserver.js';
export { SqlServerSqlExecutor } from './executor/sqlserver.js';
export type { SqlExecutor } from './executor.js';
export { MysqlIntrospector } from './introspector/mysql.js';
export { OracleIntrospector } from './introspector/oracle.js';
export type { PostgresIntrospectorOptions } from './introspector/postgres.js';
export { PostgresIntrospector } from './introspector/postgres.js';
export { SqliteIntrospector } from './introspector/sqlite.js';
export { SqlServerIntrospector } from './introspector/sqlserver.js';
export type { Dialect, IntrospectionOptions, Introspector } from './introspector.js';
export type { ProcessLock } from './lock.js';
export { acquireProcessLock } from './lock.js';
export type {
  BaselineResult,
  DeployResult,
  DevResult,
  MigrationProgress,
  MigrationStatus,
  MigratorOptions,
  PushResult,
  ResolveAction,
  ResolveOptions,
} from './migrator.js';
export { generateMigrationId, MigrationAbortedError, Migrator, toSqlFile } from './migrator.js';
export type { Runtime, RuntimeOptions } from './runtime.js';
export { createRuntime, DEFAULT_LOCK_PATH, DEFAULT_MIGRATIONS_DIR } from './runtime.js';
export type { SchemaDriver } from './schema/adapter.js';
export { tableDefsToSchema } from './schema/adapter.js';
export type {
  CheckConstraint,
  Column,
  Constraint,
  ForeignKeyConstraint,
  Index,
  OnDelete,
  PrimaryKeyConstraint,
  Schema,
  Table,
  UniqueConstraint,
} from './schema/model.js';
export { emptySchema } from './schema/model.js';
export { runSeed } from './seed.js';
export { ServerMigrationHistoryStore } from './server/history.js';
export { ServerSql } from './server/sql.js';
export type { SchemaSnapshot } from './snapshot.js';
export {
  fromSnapshot,
  isSchema,
  SNAPSHOT_FORMAT_VERSION,
  toSnapshot,
} from './snapshot.js';
export type { SqlQueryable } from './sql.js';
export type {
  AppliedMigration,
  MigrationFile,
  MigrationFileStore,
  MigrationHistoryStore,
} from './store.js';
export {
  checksumOf,
  DatabaseMigrationHistoryStore,
  DEFAULT_HISTORY_TABLE,
  FileMigrationStore,
} from './store.js';

export type { TablePattern } from './table-filter.js';
