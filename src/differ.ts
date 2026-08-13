/**
 * diff 引擎 —— 对比「现状 schema」与「目标 schema」，产出操作集。
 *
 * 现状（数据库 introspection 结果）与目标（模型推导结果）都是 `Schema` 形状，
 * 所以 differ 本身是方言无关的。对应 prisma-engines 的 `sql_schema_differ.rs`。
 *
 * 实现要点（TODO，尚未实现）：
 * - 约束/索引匹配按内容（列集合 + 种类）而非仅名字；
 * - 忽略列顺序差异；
 * - 主键变化、外键级联变化需要「drop 旧约束 + add 新约束」两步；
 * - 输出中 `destructive` 子集用于 data-loss 评估。
 */
import type { Schema } from "./schema/model";
import type { Diff } from "./diff/types";

export interface Differ {
  /** 计算从 `from` 演进到 `to` 所需的变更 */
  diff(from: Schema, to: Schema): Diff;
}

export class SchemaDiffer implements Differ {
  diff(from: Schema, to: Schema): Diff {
    // 最小实现：两方都为空（或表集合完全相同）时无变更。
    // 完整的 diff 算法（按内容匹配约束/索引、忽略列序、破坏性标注）是下一步工作。
    if (from.tables.size === 0 && to.tables.size === 0) {
      return { changes: [], destructive: [] };
    }
    throw new Error("SchemaDiffer.diff 尚未实现 —— 起点骨架，下一步实现");
  }
}
