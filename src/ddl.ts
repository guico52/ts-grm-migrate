/**
 * DDL 生成器 —— 把语义层的 diff 操作集翻译成方言 SQL。
 *
 * 对应 prisma-engines 的 `libs/sql-ddl`（语句构造）+ `sql_renderer.rs`（方言分发）。
 * 每个方言一个实现（本起点先做 Postgres）。
 *
 * 方言差异的集中点：
 * - PG：DDL 可事务；约束名可确定性生成；`ALTER COLUMN TYPE` 需要时补 `USING`；
 *       部分操作会全表重写并持 ACCESS EXCLUSIVE 锁（可生成注释警告）；
 * - SQLite：alter 能力极弱（不能 drop column / 改类型），需要「重建表」路径，
 *       因此生成器需要支持从零生成完整建表 SQL（已有 ts-grm 的 TableDef.toCreationStatements 可借鉴）；
 * - MySQL：DDL 隐式提交，不可事务。
 */
import type { Diff } from "./diff/types";
import type { Schema } from "./schema/model";
import type { Dialect } from "./introspector";

export interface DdlGenerator {
  readonly dialect: Dialect;

  /** 把 diff 渲染为按序执行的 SQL 语句数组 */
  statements(diff: Diff): ReadonlyArray<string>;

  /**
   * 把整个 schema 渲染为建表 SQL（用于重建表路径 / 影子库初始化）。
   * 等价于 ts-grm `TableDef.toCreationStatements()` 的方言实现。
   */
  createStatements(schema: Schema): ReadonlyArray<string>;
}
