/**
 * DDL 生成器 —— 把语义层的 diff 操作集翻译成方言 SQL。
 *
 * 对应 prisma-engines 的 `libs/sql-ddl`（语句构造）+ `sql_renderer.rs`（方言分发）。
 * 每个方言一个实现（Postgres / SQLite 见 src/ddl/）。
 *
 * 生成策略（整表级操作条件复用 ts-grm 原生，列/约束级变更自建）：
 * - CREATE_TABLE / SQLite 重建表：若提供了目标态 TableDef 映射（生成期持有），
 *   走 ts-grm 原生 `toCreationStatements(driver)`，保证与 ts-grm 建表语义零漂移；
 *   否则回退到自建（本文件的 createTableSql，语义等价）。
 * - ADD/DROP COLUMN、ALTER COLUMN、ADD/DROP CONSTRAINT、索引：自建。
 *   ts-grm 没有单条变更 API，这部分是 migrate 的核心职责。
 * - SQLite 的 drop column / 改类型 / 改约束无法原地执行 → 重建表路径
 *   （drop 旧表 + 原生建表 + 数据迁移 TODO，见 src/ddl/sqlite.ts）。
 */
import type { Diff } from "./diff/types.js";
import type {
  Column,
  Constraint,
  Index,
  OnDelete,
  Schema,
  Table as SchemaTable,
} from "./schema/model.js";
import type { SchemaDriver } from "./schema/adapter.js";
import type { TableDef } from "./vendor/ts-grm.js";
import type { Dialect } from "./introspector.js";

/** Both states from the same introspection/diff pass, needed by whole-column DDL. */
export interface DdlContext {
  readonly from: Schema;
  readonly to: Schema;
}

export interface DdlGenerator {
  readonly dialect: Dialect;

  /** 把 diff 渲染为按序执行的 SQL 语句数组 */
  statements(diff: Diff, context?: DdlContext): ReadonlyArray<string>;

  /**
   * 把整个 schema 渲染为建表 SQL（用于重建表路径 / 影子库初始化）。
   * 传入目标态 TableDef 映射时逐表复用 ts-grm 原生 toCreationStatements。
   */
  createStatements(schema: Schema): ReadonlyArray<string>;
}

/** DDL 生成器构造选项（目前仅 SQLite 需要：重建表/建表复用 ts-grm 原生） */
export interface DdlGeneratorOptions {
  /** 方言类型映射（原生 toCreationStatements 需要；提供 tableDefs 时必填） */
  driver?: SchemaDriver;
  /** 表名 → 原生 TableDef（目标态模型产物；CREATE_TABLE / 重建表时条件复用原生） */
  tableDefs?: ReadonlyMap<string, TableDef>;
}

// ---- 共享工具 --------------------------------------------------------------

/** 标识符加引号（方言无关的通用形式；表名/列名来自数据库实际名字，加引号防保留字/大小写折叠） */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** 列定义片段：`"NAME" type [null|not null]` */
export function columnSql(column: Column): string {
  return `${quoteIdentifier(column.name)} ${column.type}${
    column.nullable ? " null" : " not null"
  }`;
}

/** ON DELETE 动作 → SQL 子句（空串 = 省略，方言默认行为） */
export function onDeleteSql(onDelete: OnDelete): string {
  switch (onDelete) {
    case "CASCADE":
      return " on delete cascade";
    case "SET_NULL":
      return " on delete set null";
    case "SET_DEFAULT":
      return " on delete set default";
    case "RESTRICT":
      return " on delete restrict";
    case "NO_ACTION":
      return "";
  }
}

/** 约束名：显式名字优先，否则按表/种类确定性生成（diff 内容匹配，名字只用于 DDL） */
export function constraintName(table: string, constraint: Constraint, seq: number): string {
  if (constraint.name != null) {
    return constraint.name;
  }
  switch (constraint.kind) {
    case "PRIMARY_KEY":
      return `${table}_pk`;
    case "UNIQUE":
      return `${table}_uq_${constraint.columns.join("_")}`;
    case "FOREIGN_KEY":
      return `${table}_fk_${constraint.columns.join("_")}`;
    case "CHECK":
      return `${table}_ck_${seq}`;
  }
}

/**
 * 从零生成建表 SQL（自建兜底；提供 TableDef 映射时由方言实现改走 ts-grm 原生）。
 * 约束全部 inline（PG / SQLite 都支持表级约束），语义与 ts-grm toCreationStatements 等价。
 */
export function createTableSql(table: SchemaTable): string {
  const parts: Array<string> = [];
  for (const column of table.columns) {
    parts.push(`  ${columnSql(column)}`);
  }
  let seq = 0;
  for (const constraint of table.constraints) {
    parts.push(`  ${constraintSql(constraint, constraintName(table.name, constraint, ++seq))}`);
  }
  for (const index of table.indexes) {
    parts.push(`  ${indexSql(table.name, index)}`);
  }
  return `create table ${quoteIdentifier(table.name)} (\n${parts.join(",\n")}\n)`;
}

/** 表级约束片段（inline 形态） */
export function constraintSql(constraint: Constraint, name: string): string {
  switch (constraint.kind) {
    case "PRIMARY_KEY":
      return `constraint ${quoteIdentifier(name)} primary key (${constraint.columns.map(quoteIdentifier).join(", ")})`;
    case "UNIQUE":
      return `constraint ${quoteIdentifier(name)} unique (${constraint.columns.map(quoteIdentifier).join(", ")})`;
    case "FOREIGN_KEY":
      return (
        `constraint ${quoteIdentifier(name)} foreign key (${constraint.columns.map(quoteIdentifier).join(", ")})` +
        ` references ${quoteIdentifier(constraint.referencedTable)} (${constraint.referencedColumns.map(quoteIdentifier).join(", ")})` +
        onDeleteSql(constraint.onDelete)
      );
    case "CHECK":
      return `constraint ${quoteIdentifier(name)} check (${constraint.expression})`;
  }
}

/** 索引片段（inline 形态，createTableSql 内使用） */
export function indexSql(table: string, index: Index): string {
  return (
    `constraint ${quoteIdentifier(index.name)} ${index.unique ? "unique " : ""}index` +
    ` (${index.columns.map(quoteIdentifier).join(", ")})`
  );
}
