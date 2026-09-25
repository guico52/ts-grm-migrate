/**
 * 目标态适配器：ts-grm 原生 TableDef[] → migrate 统一形状 Schema。
 *
 * 原则（见 model.ts 注释）：纯字段搬运，不重新设计表和字段结构。
 * - type 直接用 driver.typeName(columnDef)——与 ts-grm 实际建表行为完全一致，
 *   保证「模型建的表 == 目标态 == 现状 introspection」自洽（不修正 ts-grm 的
 *   映射现状，否则 diff 会永远不相等）；
 * - 模型语义字段（entity/prop/when）丢弃——多态列归一化为普通 nullable 列
 *   （docs/design.md 已定：多态语义的丢失由模型侧适配器负责）；
 * - migrate 特有字段（default/autoIncrement/comment/索引）模型侧无来源 → 空值，
 *   后续由补充声明机制填充；
 * - 约束名不填充（ts-grm 自动名 {table}_constraint_{n} 不可靠，diff 按内容匹配）。
 */
import type {ColumnDef, ConstraintDef, SchemaDriver, TableDef,} from "../vendor/ts-grm.js";
import type {CheckConstraint, Column, Constraint, ForeignKeyConstraint, OnDelete, Schema, Table,} from "./model.js";
import { normalizeServerType } from "../server/sql.js";
import { normalizeServerExpression } from "../server/catalog.js";
import { normalizeMysqlType, normalizeMysqlCheck } from "../mysql/sql.js";
import type { DialectName } from "../dialect.js";

/**
 * 方言映射能力（上游 Driver 的最小结构化投影）。
 * 定义在 vendor 层（上游适配点），此处再导出以保持既有导入路径。
 */
export type { SchemaDriver };

/** 表名去引号（ts-grm 对保留字表名会带引号，如 "\"ORDER\""；数据库实际名字不带） */
/**
 * 上游标识符 → 数据库里的**物理名**。
 *
 * ts-grm 的 `toTableName()` 是 `quoteIdentifier(toSnakeCase(...))`（`core/src/impl/entity.ts:206`），
 * 而它的 `quoteIdentifier` **只对 SQL 关键字加引号**，其余原样返回
 * （`sql/src/driver/abstract_drivier.ts:60`）。于是：
 *
 * - 带引号（如 `"ORDER"`）：按字面解析，物理名就是引号里的内容
 * - **不带引号（如 `AUTHOR`）：PG 会把未加引号的标识符折叠为小写，物理名是 `author`**
 *
 * 必须复刻这条折叠规则：否则模型侧会拿 `AUTHOR` 与 introspect 读到的 `author` 比较，
 * diff 永远不相等；更严重的是 DDL 再加引号就会真的建出大写表，
 * 而 ts-grm 运行时用无引号查询（折叠为小写）根本找不到它。
 *
 * 折叠规则属于方言知识（PG 折叠小写；MySQL/SQLite 不折叠），
 * 将来支持多方言时应下移到方言层。
 */
function toPhysicalName(value: string, dialect: DialectName): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replaceAll(value[0] === "[" ? "]]" : value[0]!.repeat(2), value[0] === "[" ? "]" : value[0]!);
  }
  if (value.startsWith("`") && value.endsWith("`")) {
    return value.slice(1, -1).replaceAll(value[0] === "[" ? "]]" : value[0]!.repeat(2), value[0] === "[" ? "]" : value[0]!);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).replaceAll(value[0] === "[" ? "]]" : value[0]!.repeat(2), value[0] === "[" ? "]" : value[0]!);
  }
  // 未加引号的标识符：PG 折叠为小写；MySQL / SQLite 原样保留（见上方注释）
  return dialect === "postgres" ? value.toLowerCase() : dialect === "oracle" ? value.toUpperCase() : value;
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
    .map((v) => (typeof v === "number" ? v.toString() : `'${v.replaceAll("'", "''")}'`))
    .join(", ");
  return `${constraint.column.name} in (${values})`;
}

function toColumn(
  columnDef: ColumnDef,
  ordinal: number,
  driver: SchemaDriver,
  dialect: DialectName,
): Column {
  return {
    name: toPhysicalName(columnDef.name, dialect),
    type: dialect === "mysql" ? normalizeMysqlType(driver.typeName(columnDef))
      : dialect === "mssql" || dialect === "oracle" ? normalizeServerType(driver.typeName(columnDef), dialect) : driver.typeName(columnDef),
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
  dialect: DialectName,
): Constraint {
  const name: string | undefined = undefined;
  switch (constraint.kind) {
    case "PRIMARY_KEY":
      return {
        kind: "PRIMARY_KEY",
        name,
        columns: constraint.columns.map((c) => toPhysicalName(c.name, dialect)),
        implicit: constraint.implicit,
      };
    case "UNIQUE":
      return {
        kind: "UNIQUE",
        name,
        columns: constraint.columns.map((c) => toPhysicalName(c.name, dialect)),
        implicit: constraint.implicit,
      };
    case "FOREIGN_KEY": {
      return {
        kind: "FOREIGN_KEY",
        name,
        columns: constraint.columns.map((c) => toPhysicalName(c.name, dialect)),
        referencedTable: toPhysicalName(
          constraint.referencedColumns[0]!.declaringTable.name,
          dialect,
        ),
        referencedColumns: constraint.referencedColumns.map((c) => toPhysicalName(c.name, dialect)),
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
        ...(dialect === "mysql" ? { comparisonExpression: normalizeMysqlCheck(checkExpression(constraint)) }
          : dialect === "mssql" || dialect === "oracle" ? { comparisonExpression: normalizeServerExpression(checkExpression(constraint)) } : {}),
        implicit: constraint.implicit,
      };
      return check;
    }
    default:
      // 原生联合中的 "INDEX" 类型存在但 ts-grm 从不创建，防御处理
      throw new Error(`Unsupported constraint type: ${String((constraint as { kind?: unknown }).kind)}`);
  }
}

function toTable(tableDef: TableDef, driver: SchemaDriver, dialect: DialectName): Table {
  return {
    name: toPhysicalName(tableDef.name, dialect),
    columns: tableDef.columns.map((c, i) => toColumn(c, i + 1, driver, dialect)),
    constraints: tableDef.constraints.map((c) => toConstraint(c, driver, dialect)),
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
  options: { readonly dialect?: DialectName } = {},
): Schema {
  // 标识符折叠规则属于方言知识，默认按 PG（当前唯一端到端可用的方言）
  const dialect = options.dialect ?? "postgres";
  return {
    tables: tableDefs.map((td) => toTable(td, driver, dialect)),
  };
}
