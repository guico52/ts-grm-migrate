/**
 * diff 引擎 —— 对比「现状 schema」与「目标 schema」，产出操作集。
 *
 * 现状（数据库 introspection 结果）与目标（模型推导结果）都是 `Schema` 形状，
 * 所以 differ 本身是方言无关的。对应 prisma-engines 的 `sql_schema_differ.rs`。
 *
 * 匹配规则（docs/design.md 设计决策）：
 * - 列按名字匹配（列名在表内唯一）；
 * - 约束/索引**按内容匹配而非名字**——自动生成的约束名（如 ts-grm 的
 *   `{table}_constraint_{n}`）不可靠；内容相同视为同一约束；
 * - CHECK 按表达式原文比较（现状 introspection 与目标适配器的表达式写法可能
 *   有格式差异，暂不做归一化，差异会表现为 drop+add——后续增强）；
 * - 列顺序差异忽略（PG/SQLite 都无法在 alter 里调列序）。
 *
 * 「不管理」语义（模型侧缺失字段）：
 * - 列 default / comment：目标态为 undefined = 不参与 diff（现状保留）；
 * - 列 autoIncrement：模型侧无来源（恒 false），当前版本忽略该字段的差异，
 *   需要管理自增时由 migrate 侧补充声明机制提供目标值（未来）；
 * - 约束/索引是结构性的，目标态缺失 = 删除（目标态是权威描述）。
 *
 * 破坏性标注（data-loss 评估）：
 * - DROP_TABLE / DROP_COLUMN / ALTER_COLUMN（类型变化）→ destructive；
 * - 其余（加列、改 nullable、默认值、约束、索引）→ 非破坏。
 *
 * 输出顺序：CREATE_TABLE → ALTER_TABLE → DROP_TABLE（新建先行，删除在后）。
 */
import type { Schema, Table, Column, Constraint, Index } from "./schema/model.js";
import type {
  AlterTable,
  Change,
  ColumnChange,
  ConstraintChange,
  DestructiveChange,
  Diff,
  IndexChange,
} from "./diff/types.js";

export interface Differ {
  /** 计算从 `from` 演进到 `to` 所需的变更 */
  diff(from: Schema, to: Schema): Diff;
}

export class SchemaDiffer implements Differ {
  diff(from: Schema, to: Schema): Diff {
    const fromMap = new Map(from.tables.map((t) => [t.name, t]));
    const toMap = new Map(to.tables.map((t) => [t.name, t]));

    const changes: Array<Change> = [];
    const destructive: Array<DestructiveChange> = [];

    // 1) 目标有的表：新建或变更
    for (const toTable of to.tables) {
      const fromTable = fromMap.get(toTable.name);
      if (fromTable == null) {
        changes.push({ kind: "CREATE_TABLE", table: toTable });
        continue;
      }
      const alter = this._alterTable(fromTable, toTable);
      if (alter != null) {
        changes.push(alter);
        destructive.push(...this._destructiveOf(alter));
      }
    }

    // 2) 现状有而目标没有的表：删除
    for (const fromTable of from.tables) {
      if (!toMap.has(fromTable.name)) {
        // 带上该表自身的外键名：DDL 层据此在删表前先摘掉它们，
        // 否则被引用的表（同样要删）会因依赖关系删不掉（见 DropTable 注释）。
        // 被删表来自 introspection，约束名必定存在；缺失就宁可不生成语句，
        // 让错误在数据库里暴露，而不是静默跳过。
        const foreignKeyNames = fromTable.constraints
          .filter((c) => c.kind === "FOREIGN_KEY")
          .map((c) => c.name)
          .filter((name): name is string => name != null);

        changes.push({ kind: "DROP_TABLE", table: fromTable.name, foreignKeyNames });
        destructive.push({ kind: "DROP_TABLE", table: fromTable.name, foreignKeyNames });
      }
    }

    return { changes, destructive };
  }

  /** 单表变更；无任何变化返回 null */
  private _alterTable(from: Table, to: Table): AlterTable | null {
    const columns = this._columnChanges(from, to);
    const constraints = this._constraintChanges(from, to);
    const indexes = this._indexChanges(from, to);
    if (columns.length === 0 && constraints.length === 0 && indexes.length === 0) {
      return null;
    }
    return { kind: "ALTER_TABLE", table: to.name, columns, constraints, indexes };
  }

  private _columnChanges(from: Table, to: Table): Array<ColumnChange> {
    const changes: Array<ColumnChange> = [];
    const fromCols = new Map(from.columns.map((c) => [c.name, c]));
    const toCols = new Map(to.columns.map((c) => [c.name, c]));

    for (const toCol of to.columns) {
      const fromCol = fromCols.get(toCol.name);
      if (fromCol == null) {
        changes.push({ kind: "ADD_COLUMN", column: toCol });
        continue;
      }
      const alter = this._alterColumn(fromCol, toCol);
      if (alter != null) {
        changes.push(alter);
      }
    }
    for (const fromCol of from.columns) {
      if (!toCols.has(fromCol.name)) {
        changes.push({ kind: "DROP_COLUMN", column: fromCol.name });
      }
    }
    return changes;
  }

  /** 列变更；无变化返回 null */
  private _alterColumn(
    from: Column,
    to: Column,
  ): Extract<ColumnChange, { readonly kind: "ALTER_COLUMN" }> | null {
    const change: Extract<ColumnChange, { readonly kind: "ALTER_COLUMN" }> = {
      kind: "ALTER_COLUMN",
      column: to.name,
      type: from.type !== to.type ? to.type : undefined,
      nullable: from.nullable !== to.nullable ? to.nullable : undefined,
      // default：目标 undefined = 不管理；"" = 删除；其他 = 设置（仅当与现状不同）
      default:
        to.default !== undefined && (to.default === "" ? from.default !== undefined : !sameDefault(to.default, from.default)) ? to.default : undefined,
      // autoIncrement：模型侧无来源（不管理），当前版本忽略
      autoIncrement: undefined,
    };
    const changed =
      change.type != null || change.nullable != null || change.default != null;
    return changed ? change : null;
  }

  /** 约束：内容匹配（kind + 列集合 [+ 引用/表达式]），名字不算内容；DROP 先于 ADD 执行 */
  private _constraintChanges(from: Table, to: Table): Array<ConstraintChange> {
    const changes: Array<ConstraintChange> = [];
    const fromKeys = new Set(from.constraints.map(constraintKey));
    const toKeys = new Set(to.constraints.map(constraintKey));
    for (const constraint of from.constraints) {
      if (!toKeys.has(constraintKey(constraint))) {
        changes.push({ kind: "DROP_CONSTRAINT", constraint });
      }
    }
    for (const constraint of to.constraints) {
      if (!fromKeys.has(constraintKey(constraint))) {
        changes.push({ kind: "ADD_CONSTRAINT", constraint });
      }
    }
    return changes;
  }

  /** 索引：内容匹配（唯一性 + 列集合 + 谓词），名字不算内容；DROP 先于 ADD 执行 */
  private _indexChanges(from: Table, to: Table): Array<IndexChange> {
    const changes: Array<IndexChange> = [];
    const managedFrom = from.indexes.filter((index) => !index.implicit);
    const fromKeys = new Set(from.indexes.map(indexKey));
    const toKeys = new Set(to.indexes.map(indexKey));
    for (const index of managedFrom) {
      if (!toKeys.has(indexKey(index))) {
        changes.push({ kind: "DROP_INDEX", index });
      }
    }
    for (const index of to.indexes) {
      if (!fromKeys.has(indexKey(index))) {
        changes.push({ kind: "ADD_INDEX", index });
      }
    }
    return changes;
  }

  /** ALTER_TABLE 中的破坏性子集 */
  private _destructiveOf(alter: AlterTable): Array<DestructiveChange> {
    const destructive: Array<DestructiveChange> = [];
    for (const col of alter.columns) {
      switch (col.kind) {
        case "DROP_COLUMN":
          destructive.push({ kind: "DROP_COLUMN", table: alter.table, column: col.column });
          break;
        case "ALTER_COLUMN":
          // 类型变化可能丢数据（PG 的类型转换、长度收缩等）；nullable/默认值不破坏
          if (col.type != null) {
            destructive.push({
              kind: "ALTER_COLUMN",
              table: alter.table,
              column: col.column,
              type: col.type,
            });
          }
          break;
      }
    }
    return destructive;
  }
}

/** 约束的内容签名（匹配依据） */
function constraintKey(constraint: Constraint): string {
  switch (constraint.kind) {
    case "PRIMARY_KEY":
      return `pk:${constraint.columns.join(",")}`;
    case "UNIQUE":
      return `uq:${constraint.columns.join(",")}`;
    case "FOREIGN_KEY":
      return `fk:${constraint.columns.join(",")}->${constraint.referencedTable}(${constraint.referencedColumns.join(",")})@${constraint.onDelete}`;
    case "CHECK":
      return `ck:${constraint.comparisonExpression ?? constraint.expression}`;
  }
}

/** 索引的内容签名（匹配依据） */
function indexKey(index: Index): string {
  return `${index.unique ? "uniq" : "idx"}:${index.columns.join(",")}${
    index.predicate != null ? `:${index.predicate}` : ""
  }`;
}

/** Catalogs often wrap DEFAULT expressions in parentheses. Preserve quoted data verbatim. */
function sameDefault(left: string, right: string | undefined): boolean {
  const canonical = (value: string): string => {
    const tokens = value.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s]/g) ?? [];
    while (tokens[0] === "(" && tokens.at(-1) === ")") {
      let depth = 0;
      if (!tokens.every((t, i) => { if (t === "(") depth++; if (t === ")") depth--; return depth > 0 || i === tokens.length - 1; })) break;
      tokens.shift(); tokens.pop();
    }
    return tokens.join(" ");
  };
  return right !== undefined && canonical(left) === canonical(right);
}
