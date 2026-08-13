/**
 * @ts-grm/migrate — ts-grm 的 schema 迁移引擎（起点骨架）。
 *
 * 分层（对应 prisma-engines 的目录结构）：
 * - schema/model.ts   数据库 schema 中间表示   (database_schema.rs)
 * - differ.ts         diff 引擎                (sql_schema_differ.rs)
 * - introspector.ts   数据库现状读取            (introspection.rs + sql-schema-describer)
 * - ddl.ts            DDL 生成（方言）          (libs/sql-ddl + sql_renderer.rs)
 * - store.ts          迁移文件 + 历史表         (sql_migration.rs / sql_migration_persistence.rs)
 * - migrator.ts       迁移应用器                (apply_migration.rs / apply_migrations.rs)
 */
export type { Schema, Table, Column, Constraint, Index } from "./schema/model";
export { emptySchema } from "./schema/model";
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
} from "./diff/types";
export type { Differ } from "./differ";
export { SchemaDiffer } from "./differ";
export type { Introspector, Dialect } from "./introspector";
export type { DdlGenerator } from "./ddl";
export type {
  MigrationFile,
  AppliedMigration,
  MigrationStore,
} from "./store";
export type { MigratorOptions, SqlExecutor } from "./migrator";
export { Migrator } from "./migrator";
