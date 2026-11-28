/**
 * Introspector —— 从真实数据库读取当前 schema。
 *
 * 对应 prisma-engines 的 `introspection.rs` + `sql-schema-describer`。
 * 每个方言一个实现（本起点先做 Postgres）。
 *
 * 注意（外部输入路径，错误处理必须优雅，绝不 fail-fast）：
 * - introspection 读到的所有内容都是「外部输入」，解析失败要变成带方言与表名的可读错误；
 * - 类型字符串原样保留（"bigint"、"varchar(50)"），归一化是 DDL 层/适配层的事；
 * - 标识符大小写按数据库实际存储返回（PG 未加引号建的会是小写）。
 */
import type { Schema } from './schema/model.js';
import type { SqlQueryable } from './sql.js';
import { createTableMatcher, type TablePattern } from './table-filter.js';

/** 最小查询能力（定义在 `src/sql.ts`，此处再导出以保持既有导入路径） */
export type { SqlQueryable };

export interface IntrospectionOptions {
  readonly excludeTables?: ReadonlyArray<TablePattern>;
  /** 排除表指向其他表的依赖，用于阻止越界变更。 */
  readonly onExcludedReference?: (table: string, referencedTable: string) => void;
}

/** 在解析特殊结构之前过滤 catalog，同时保留排除表的外键依赖。 */
export function createCatalogTableFilter(
  options: IntrospectionOptions,
): (table: string, referencedTable?: string) => boolean {
  const excluded = createTableMatcher(options.excludeTables);
  return (table, referencedTable) => {
    if (!excluded(table)) return true;
    if (referencedTable) options.onExcludedReference?.(table, referencedTable);
    return false;
  };
}

export interface Introspector {
  readonly dialect: Dialect;

  /** 读取管理范围内的结构；排除表需在解析特殊结构前过滤。 */
  introspect(options?: IntrospectionOptions): Promise<Schema>;
}

import type { DialectName } from './dialect.js';

export type { DialectName };

/**
 * 方言标识。
 *
 * 与 `src/dialect.ts` 的 `DialectName` 同义，保留 `Dialect` 这个名字是为了
 * 贴合上游（ts-grm 用 `Driver`/`dialect` 的用词）以及各实现文件现有的写法。
 */
export type Dialect = DialectName;
