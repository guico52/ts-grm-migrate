/**
 * 目标态适配器：ts-grm 原生 TableDef[] → migrate 统一形状 Schema。
 *
 * 原则（见 model.ts 注释）：纯字段搬运，不重新设计表和字段结构。
 * - type 直接用 driver.typeName(columnDef)——与 ts-grm 实际建表行为完全一致，
 *   保证「模型建的表 == 目标态 == 现状 introspection」自洽（不修正 ts-grm 的
 *   映射现状，否则 diff 会永远不相等）；
 * - 模型语义字段（entity/prop/when）丢弃——多态列归一化为普通 nullable 列
 *   （README 已定：多态语义的丢失由模型侧适配器负责）；
 * - migrate 特有字段（default/autoIncrement/comment/索引）模型侧无来源 → 空值，
 *   后续由补充声明机制填充；
 * - 约束名不填充（ts-grm 自动名 {table}_constraint_{n} 不可靠，diff 按内容匹配）。
 */
import type {ColumnDef, ConstraintDef, SchemaDriver, TableDef,} from "../vendor/ts-grm.js";
import type {CheckConstraint, Column, Constraint, ForeignKeyConstraint, OnDelete, Schema, Table,} from "./model.js";

/**
 * 方言映射能力（上游 Driver 的最小结构化投影）。
 * 定义在 vendor 层（上游适配点），此处再导出以保持既有导入路径。
 */
export type { SchemaDriver };

/** 表名去引号（ts-grm 对保留字表名会带引号，如 "\"ORDER\""；数据库实际名字不带） */
function unquoteIdentifier(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }
  if (value.startsWith("`") && value.endsWith("`")) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

/** ts-grm 的 CascadeType（ORM 语义）→ 数据库 ON DELETE 动作 */
function toOnDelete(cascade: string): OnDelete {
  switch (cascade) {
    case "DELETE":
      return "CASCADE";
    case "SET_NULL":
      return "SET_NULL";
    // NONE / GRM_DELETE / GRM_SET_NULL：数据库层面无动作（GRM_* 为 ORM 预留语义）
    default:
      return "NO_ACTION";
  }
}

/** 原生 CHECK（column + values）→ 表达式原文（与 ts-grm constraintCreationSql 同构） */
function checkExpression(constraint: Extract<ConstraintDef, { readonly kind: "CHECK" }>): string {
  const values = constraint.values
    .map((v) => (typeof v === "number" ? v.toString() : `'${v}'`))
    .join(", ");
  return `${constraint.column.name} in (${values})`;
}

function toColumn(columnDef: ColumnDef, ordinal: number, driver: SchemaDriver): Column {
  return {
    name: columnDef.name,
    type: driver.typeName(columnDef),
    nullable: columnDef.nullable,
    length: columnDef.length,
    default: undefined,
    autoIncrement: false,
    ordinal,
    comment: undefined,
  };
}

function toConstraint(
  constraint: ConstraintDef,
  driver: SchemaDriver,
): Constraint {
  const name: string | undefined = undefined;
  switch (constraint.kind) {
    case "PRIMARY_KEY":
      return {
        kind: "PRIMARY_KEY",
        name,
        columns: constraint.columns.map((c) => c.name),
        implicit: constraint.implicit,
      };
    case "UNIQUE":
      return {
        kind: "UNIQUE",
        name,
        columns: constraint.columns.map((c) => c.name),
        implicit: constraint.implicit,
      };
    case "FOREIGN_KEY": {
      return {
        kind: "FOREIGN_KEY",
        name,
        columns: constraint.columns.map((c) => c.name),
        referencedTable: unquoteIdentifier(
            constraint.referencedColumns[0]!.declaringTable.name,
        ),
        referencedColumns: constraint.referencedColumns.map((c) => c.name),
        onDelete: toOnDelete(constraint.cascade),
        deferrable: false,
        cascade: constraint.cascade,
        implicit: constraint.implicit,
      };
    }
    case "CHECK": {
      const check: CheckConstraint = {
        kind: "CHECK",
        name,
        values: constraint.values,
        expression: checkExpression(constraint),
        implicit: constraint.implicit,
      };
      return check;
    }
    default:
      // 原生联合中的 "INDEX" 类型存在但 ts-grm 从不创建，防御处理
      throw new Error(`不支持的约束类型: ${String((constraint as { kind?: unknown }).kind)}`);
  }
}

function toTable(tableDef: TableDef, driver: SchemaDriver): Table {
  return {
    name: unquoteIdentifier(tableDef.name),
    columns: tableDef.columns.map((c, i) => toColumn(c, i + 1, driver)),
    constraints: tableDef.constraints.map((c) => toConstraint(c, driver)),
    // ts-grm 模型无索引概念，migrate 侧补充声明 / introspection 另行填充
    indexes: [],
  };
}

/**
 * TableDef[] → Schema。
 *
 * @param tableDefs createSchema() 的产物
 * @param driver    createSchema 所用 sqlClient 的 driver（提供方言类型映射）
 */
export function tableDefsToSchema(
  tableDefs: ReadonlyArray<TableDef>,
  driver: SchemaDriver,
): Schema {
  return {
    tables: tableDefs.map((td) => toTable(td, driver)),
  };
}
