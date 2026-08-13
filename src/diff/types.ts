/**
 * diff 操作集 —— 描述「现状 schema」到「目标 schema」需要执行的结构变更。
 *
 * 设计要点：
 *
 * 1. 这是语义层的变更描述，与方言无关；具体 SQL 由 DDL 生成器（`src/ddl.ts`）翻译。
 *    对应 prisma-engines 的 `sql_schema_differ.rs` 产出的 migration steps。
 *
 * 2. 破坏性操作（DROP_TABLE / DROP_COLUMN / 改变列类型可能丢数据）必须能被识别，
 *    供 CLI 在应用前确认或标注 data-loss 警告 —— 对应 prisma 的 `evaluate_data_loss.rs`。
 *
 * 3. diff 时忽略列顺序差异；约束/索引按「列集合 + 内容」匹配而不是只按名字，
 *    因为自动生成的约束名（如 ts-grm 的 `{table}_constraint_{n}`）不可靠。
 */

import type {
  Column as SchemaColumn,
  Constraint as SchemaConstraint,
  Index as SchemaIndex,
  Table as SchemaTable,
} from "../schema/model";

/** 一次 diff 的完整结果 */
export interface Diff {
  /** 全部操作，按执行顺序 */
  readonly changes: ReadonlyArray<Change>;
  /** 破坏性操作列表（数据可能丢失），是 changes 的子集，供确认/警告 */
  readonly destructive: ReadonlyArray<DestructiveChange>;
}

export type Change =
  | CreateTable
  | DropTable
  | AlterTable;

/** 单表级别的变更集合 */
export interface AlterTable {
  readonly kind: "ALTER_TABLE";
  readonly table: string;
  readonly columns: ReadonlyArray<ColumnChange>;
  readonly constraints: ReadonlyArray<ConstraintChange>;
  readonly indexes: ReadonlyArray<IndexChange>;
}

export type ColumnChange =
  | AddColumn
  | DropColumn
  | AlterColumn;

export interface AddColumn {
  readonly kind: "ADD_COLUMN";
  readonly column: SchemaColumn;
}

export interface DropColumn {
  readonly kind: "DROP_COLUMN";
  readonly column: string;
}

export interface AlterColumn {
  readonly kind: "ALTER_COLUMN";
  readonly column: string;
  /** 类型变化（null = 不变） */
  readonly type: string | undefined;
  /** nullable 变化（undefined = 不变） */
  readonly nullable: boolean | undefined;
  /** 默认值变化：string = 设置；"" = 删除；undefined = 不变 */
  readonly default: string | "" | undefined;
  readonly autoIncrement: boolean | undefined;
  /**
   * 类型转换是否需要 USING（PG）：由方言在生成 DDL 时决定，
   * 这里只记录「类型变了」这个事实。
   */
}

export type ConstraintChange =
  | AddConstraint
  | DropConstraint;

export interface AddConstraint {
  readonly kind: "ADD_CONSTRAINT";
  readonly constraint: SchemaConstraint;
}

export interface DropConstraint {
  readonly kind: "DROP_CONSTRAINT";
  readonly constraint: SchemaConstraint;
}

export type IndexChange =
  | AddIndex
  | DropIndex;

export interface AddIndex {
  readonly kind: "ADD_INDEX";
  readonly index: SchemaIndex;
}

export interface DropIndex {
  readonly kind: "DROP_INDEX";
  readonly index: SchemaIndex;
}

export interface CreateTable {
  readonly kind: "CREATE_TABLE";
  readonly table: SchemaTable;
}

export interface DropTable {
  readonly kind: "DROP_TABLE";
  readonly table: string;
}

/** 可能丢失数据的操作子集（带表名上下文，便于 CLI 提示） */
export type DestructiveChange =
  | DropTable
  | { readonly kind: "DROP_COLUMN"; readonly table: string; readonly column: string }
  | { readonly kind: "ALTER_COLUMN"; readonly table: string; readonly column: string; readonly type: string };
