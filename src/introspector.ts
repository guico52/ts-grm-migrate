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
import type { Schema } from "./schema/model";

export interface Introspector {
  readonly dialect: Dialect;

  /** 读取数据库的完整结构 */
  introspect(): Promise<Schema>;
}

export type Dialect =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "mssql"
  | "oracle";
