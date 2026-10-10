/**
 * diff 引擎 —— 对比「现状 schema」与「目标 schema」，产出操作集。
 *
 * 现状（数据库 introspection 结果）与目标（模型推导结果）都是 `Schema` 形状，
 * 结构操作是方言无关的；默认值等价比较使用方言与列类型。对应 prisma-engines 的 `sql_schema_differ.rs`。
 *
 * 匹配规则（docs/design.md 设计决策）：
 * - 列按名字匹配（列名在表内唯一）；
 * - 约束/索引**按内容匹配而非名字**——自动生成的约束名（如 ts-grm 的
 *   `{table}_constraint_{n}`）不可靠；内容相同视为同一约束；
 * - CHECK compares supported literal membership forms across catalog formatting;
 *   arbitrary expressions retain conservative token comparison.
 * - 列顺序差异忽略（PG/SQLite 都无法在 alter 里调列序）。
 *
 * 「不管理」语义（模型侧缺失字段）：
 * - 列 default / comment：目标态为 undefined = 不参与 diff（现状保留）；
 * - 列 autoIncrement：**仅当模型侧声明了自增**（`ts-grm-patches` 已安装，
 *   见 `src/schema/patches.ts` 的 `autoIncrementManaged`）才参与比较；
 *   未安装补丁时目标态恒 false 表示「不管理」，不能当成「目标态非自增」
 *   去生成 drop identity；
 * - 约束是权威描述；独立索引只在目标态未声明 indexesManaged: false 时管理。
 *
 * 破坏性标注（data-loss 评估）：
 * - DROP_TABLE / DROP_COLUMN / ALTER_COLUMN（类型变化）→ destructive；
 * - 其余（加列、改 nullable、默认值、约束、索引）→ 非破坏。
 *
 * 输出顺序：CREATE_TABLE → ALTER_TABLE → DROP_TABLE（新建先行，删除在后）。
 */
import type { Schema, Table, Column, Constraint, Index } from "./schema/model.js";
import type { DialectName } from "./dialect.js";
import { diagnostic } from "./diagnostics/error.js";
import { checkKey } from "./schema/checks.js";
import { sameDefault } from "./schema/defaults.js";
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
  constructor(private readonly dialect: DialectName = "postgres") {}
  diff(from: Schema, to: Schema): Diff {
    if (this.dialect !== "postgres") {
      for (const table of to.tables) if (table.constraints.some(c => c.kind === "FOREIGN_KEY" && c.deferrable)) throw diagnostic("unsupported_structure", table.name, diagnostic("structure_deferred_fk"));
    }
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
    if (columns.length && from.indexes.some(index => index.unsupported)) throw diagnostic("unsupported_structure", from.name, diagnostic("structure_index", from.indexes.filter(index => index.unsupported).map(index => index.unsupported).join(", ")));
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
    // 模型侧未声明自增（未装补丁）→ 不管理：恒 false 不能当成「目标非自增」
    const autoIncrementChanged =
      to.autoIncrementManaged === true && from.autoIncrement !== to.autoIncrement;
    // 两侧都自增：identity 与 serial（PostgreSQL）是同一种能力的两种数据库写法，
    // 默认值文本差异属于表达差异，不应生成 set/drop default
    const sameAutoIncrement =
      to.autoIncrementManaged === true && to.autoIncrement && from.autoIncrement;
    const change: Extract<ColumnChange, { readonly kind: "ALTER_COLUMN" }> = {
      kind: "ALTER_COLUMN",
      column: to.name,
      type: from.type !== to.type ? to.type : undefined,
      nullable: from.nullable !== to.nullable ? to.nullable : undefined,
      // default：目标 undefined = 不管理；"" = 删除；其他 = 设置（仅当与现状不同）
      default:
        sameAutoIncrement
          ? undefined
          : autoIncrementChanged && to.autoIncrement
            ? (from.default !== undefined ? "" : undefined)
            : to.default !== undefined &&
                (to.default === "" ? from.default !== undefined : !sameDefault(to.default, from.default, to.type, this.dialect))
              ? to.default
              : undefined,
      autoIncrement: autoIncrementChanged ? to.autoIncrement : undefined,
    };
    const changed =
      change.type != null ||
      change.nullable != null ||
      change.default != null ||
      change.autoIncrement != null;
    return changed ? change : null;
  }

  /** 约束：内容匹配（kind + 列集合 [+ 引用/表达式]），名字不算内容；DROP 先于 ADD 执行 */
  private _constraintChanges(from: Table, to: Table): Array<ConstraintChange> {
    const changes: Array<ConstraintChange> = [];
    const key = (c: Constraint, table: Table): string => c.kind === "CHECK"
      ? checkKey(c.comparisonExpression ?? c.expression, this.dialect, new Map(table.columns.map(col => [col.name, col.type])))
      : constraintKey(c);
    const fromKeys = new Set(from.constraints.map(c => key(c, from)));
    const toKeys = new Set(to.constraints.map(c => key(c, to)));
    for (const constraint of from.constraints) {
      if (!toKeys.has(key(constraint, from))) {
        changes.push({ kind: "DROP_CONSTRAINT", constraint });
      }
    }
    for (const constraint of to.constraints) {
      if (!fromKeys.has(key(constraint, to))) {
        changes.push({ kind: "ADD_CONSTRAINT", constraint });
      }
    }
    return changes;
  }

  /** 索引：内容匹配（唯一性 + 列集合 + 谓词），名字不算内容；DROP 先于 ADD 执行 */
  private _indexChanges(from: Table, to: Table): Array<IndexChange> {
    if (to.indexesManaged === false) return [];
    const unsupported = [...from.indexes, ...to.indexes].find(index => index.unsupported);
    if (unsupported) throw diagnostic("unsupported_structure", `${from.name}.${unsupported.name}`, diagnostic("structure_index", unsupported.unsupported));
    const changes: Array<IndexChange> = [];
    const managedFrom = from.indexes.filter((index) => !index.implicit);
    const key = (index: Index, table: Table) => indexKey(index, this.dialect, new Map(table.columns.map(column => [column.name, column.type])));
    const fromKeys = new Set(from.indexes.map(index => key(index, from)));
    const toKeys = new Set(to.indexes.map(index => key(index, to)));
    for (const index of managedFrom) {
      if (!toKeys.has(key(index, from))) {
        changes.push({ kind: "DROP_INDEX", index });
      }
    }
    for (const index of to.indexes) {
      if (!fromKeys.has(key(index, to))) {
        changes.push({ kind: "ADD_INDEX", index });
      }
    }
    return changes;
  }

  /** ALTER_TABLE 中的破坏性子集 */
  private _destructiveOf(alter: AlterTable): Array<DestructiveChange> {
    const destructive: Array<DestructiveChange> = [];
    for (const idx of alter.indexes) {
      if (idx.kind === "DROP_INDEX" && idx.index.unique) destructive.push({ kind: "DROP_INDEX", table: alter.table, index: idx.index.name });
    }
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
      return JSON.stringify(["pk", constraint.columns]);
    case "UNIQUE":
      return JSON.stringify(["uq", constraint.columns]);
    case "FOREIGN_KEY":
      return JSON.stringify(["fk", constraint.columns, constraint.referencedTable, constraint.referencedColumns, constraint.onDelete, constraint.deferrable]);
    case "CHECK":
      return constraint.expression; // CHECKs use dialect-aware keys in _constraintChanges.
  }
}

/** 索引的内容签名（匹配依据） */
function indexKey(index: Index, dialect: DialectName, types: ReadonlyMap<string, string>): string {
  return JSON.stringify([index.unique, index.columns, index.predicate === undefined ? undefined : checkKey(index.predicate, dialect, types)]);
}
