/**
 * 对账 —— 把「模型 vs 数据库」的差异翻译成人能看懂的报告。
 *
 * 用途：迁移应用之后**再 introspect 一次**，确认数据库真的变成了模型的样子。
 * 如果仍有差异，通常意味着：
 * - 迁移未完整生效（SQL 没达到预期、被中断）
 * - 数据库被手工改动过（同事直连库改了结构、或别的工具动过）
 *
 * 与 Prisma 的关系：Prisma 的 drift 检测是「**重放迁移历史**（影子库）vs 真实库」，
 * 我们没有影子库、`from` 侧就是真实库（见 docs/design.md），所以这里做的是
 * 「**应用后再看一眼**」——覆盖「数据库 vs 模型」，不覆盖「迁移历史 vs 数据库」。
 */
import type { AlterTable, Diff } from "./diff/types.js";
import type { Constraint } from "./schema/model.js";

export interface SchemaDrift {
  /** 涉及的表 */
  readonly table: string;
  /** 人类可读的说明，如「缺少列 EMAIL」 */
  readonly summary: string;
  /**
   * 是否由**已知限制**导致（目前只有 CHECK 表达式：PG 会把它 deparse 成另一种写法，
   * 与模型侧生成的 `col in (...)` 永远不相等）。这类差异无法通过迁移消除，
   * 不应作为异常告警。
   */
  readonly known: boolean;
}

/** 把一次 diff 渲染成对账报告（空数组 = 数据库与模型一致） */
export function describeDiff(diff: Diff): ReadonlyArray<SchemaDrift> {
  const drift: Array<SchemaDrift> = [];
  for (const change of diff.changes) {
    switch (change.kind) {
      case "CREATE_TABLE":
        drift.push({
          table: change.table.name,
          summary: "数据库中不存在这张表",
          known: false,
        });
        break;
      case "DROP_TABLE":
        drift.push({
          table: change.table,
          summary: "数据库中多出这张表（模型里已不存在）",
          known: false,
        });
        break;
      case "ALTER_TABLE":
        drift.push(...describeAlter(change));
        break;
    }
  }
  return drift;
}

function describeAlter(alter: AlterTable): Array<SchemaDrift> {
  const drift: Array<SchemaDrift> = [];
  const { table } = alter;

  for (const column of alter.columns) {
    switch (column.kind) {
      case "ADD_COLUMN":
        drift.push({ table, summary: `缺少列 ${column.column.name}`, known: false });
        break;
      case "DROP_COLUMN":
        drift.push({ table, summary: `多出列 ${column.column}`, known: false });
        break;
      case "ALTER_COLUMN": {
        const parts: Array<string> = [];
        if (column.type != null) {
          parts.push(`类型应为 ${column.type}`);
        }
        if (column.nullable != null) {
          parts.push(column.nullable ? "应为可空" : "应为非空");
        }
        if (column.default !== undefined) {
          parts.push(column.default === "" ? "应无默认值" : `默认值应为 ${column.default}`);
        }
        drift.push({ table, summary: `列 ${column.column}：${parts.join("，")}`, known: false });
        break;
      }
    }
  }

  for (const change of alter.constraints) {
    const label = describeConstraint(change.constraint);
    drift.push({
      table,
      summary: change.kind === "ADD_CONSTRAINT" ? `缺少约束 ${label}` : `多出约束 ${label}`,
      // CHECK 的表达式在 PG 里会被 deparse（见文件头注释），永远对不齐
      known: change.constraint.kind === "CHECK",
    });
  }

  for (const change of alter.indexes) {
    drift.push({
      table,
      summary:
        change.kind === "ADD_INDEX"
          ? `缺少索引 ${change.index.name} (${change.index.columns.join(", ")})`
          : `多出索引 ${change.index.name} (${change.index.columns.join(", ")})`,
      known: false,
    });
  }

  return drift;
}

function describeConstraint(constraint: Constraint): string {
  switch (constraint.kind) {
    case "PRIMARY_KEY":
      return `primary key (${constraint.columns.join(", ")})`;
    case "UNIQUE":
      return `unique (${constraint.columns.join(", ")})`;
    case "FOREIGN_KEY":
      return `foreign key (${constraint.columns.join(", ")}) → ${constraint.referencedTable}`;
    case "CHECK":
      return `check (${truncate(constraint.expression, 60)})`;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 过滤出真正的异常（排除已知限制造成的噪声） */
export function abnormalDrift(drift: ReadonlyArray<SchemaDrift>): ReadonlyArray<SchemaDrift> {
  return drift.filter((d) => !d.known);
}
