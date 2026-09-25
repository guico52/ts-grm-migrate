/**
 * 方言注册表 —— 「有哪些方言、上游由谁提供、migrate 实现到哪一步」的唯一出处。
 *
 * 这里不含任何实现。各层实现按方言分文件（`introspector/`、`ddl/`、`executor/`），
 * 未实现的分支由 runtime 在装配**之前**拒掉，并给出准确提示，而不是运行到一半才炸。
 *
 * 为什么集中成一张表：ts-grm 的**驱动型号比方言多** —— SQL Server 有 2012 变体、
 * Oracle 有 12 变体，型号散落在配置/装配代码里很容易漏。将来补一个方言，
 * 只需要在这里把 `implemented` 翻过来、并加上对应实现文件。
 *
 * 上游驱动清单核对自 `@ts-grm/sql` 的导出（packages/sql/src/index.ts）。
 */

/** migrate 的方言标识 */
export type DialectName = "postgres" | "mysql" | "sqlite" | "mssql" | "oracle";

/** 单个方言的支持情况 */
export interface DialectInfo {
  readonly name: DialectName;
  /**
   * ts-grm 上游对应的驱动类名。多个表示版本变体。
   * 拼写沿用上游（`Oracle12Drivier` 上游就是这个名字，不是笔误）。
   */
  readonly tsGrmDrivers: ReadonlyArray<string>;
  /**
   * migrate 是否**端到端可用**（结构读取 + DDL 生成 + 语句执行都具备）。
   *
   * 五种方言均已接通；具体版本和能力边界见 README。
   */
  readonly implemented: boolean;
}

export const DIALECTS: ReadonlyArray<DialectInfo> = [
  { name: "postgres", tsGrmDrivers: ["PostgresDriver"], implemented: true },
  { name: "mysql", tsGrmDrivers: ["MySqlDriver"], implemented: true },
  { name: "sqlite", tsGrmDrivers: ["SqliteDriver"], implemented: true },
  { name: "mssql", tsGrmDrivers: ["SqlServerDriver", "SqlServer2012Driver"], implemented: true },
  { name: "oracle", tsGrmDrivers: ["OracleDriver", "Oracle12Drivier"], implemented: true },
];

/** 全部方言名（供配置校验与错误提示） */
export const DIALECT_NAMES: ReadonlyArray<DialectName> = DIALECTS.map((d) => d.name);

/** 已端到端可用的方言名 */
export const IMPLEMENTED_DIALECT_NAMES: ReadonlyArray<DialectName> = DIALECTS.filter(
  (d) => d.implemented,
).map((d) => d.name);

/**
 * 取某个方言的支持信息。
 * 类型上入参已受限，但配置文件可能是无类型的 JS，所以这里仍做运行时兜底。
 */
export function dialectInfo(name: string): DialectInfo {
  const found = DIALECTS.find((d) => d.name === name);
  if (found == null) {
    throw new Error(
      `Unknown dialect "${name}". Known dialects: ${DIALECT_NAMES.join(" / ")} (implemented: ` +
        `${IMPLEMENTED_DIALECT_NAMES.join(" / ")}).`,
    );
  }
  return found;
}
