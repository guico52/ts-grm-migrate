/**
 * 迁移引擎的「统一比较形状」——现状（introspection）与目标态（模型）都填充此形状。
 *
 * 设计原则：不重复设计表和字段结构。本模块的类型基于上游原生定义
 * （`TableDef` / `ColumnDef` / `ConstraintDef`，经 `src/vendor/ts-grm.ts` 镜像引入）
 * **直接继承引用**：
 *
 * - Omit 掉模型语义字段（entity / prop / declaringTable / when）与建表方法——
 *   introspection 读出的现状表没有这些，快照也无法序列化它们；
 * - 保留结构字段（name / nullable / length / kind / cascade / implicit / values 等）；
 * - 补充 migrate 特有信息：方言类型字符串、默认值、自增、列序号、注释、索引
 *   （ts-grm 模型表达不了，来源：migrate 侧补充声明 / introspection）。
 *
 * 列类型 `type` 用「方言原生类型字符串」（如 "bigint" / "text" / "varchar(50)"）：
 * - introspector 从数据库读到什么存什么（无损，保留 numeric(10,2) 等带参类型）；
 * - 目标态由 ColumnDef 的 ScalarType 经方言映射得到（见 src/schema/adapter.ts），
 *   映射与 ts-grm 实际建表行为保持一致，保证「模型建的表 == 目标态 == 现状」自洽。
 *
 * 序列化：本形状是纯数据（无方法、无循环引用），快照直接 JSON（见 src/snapshot.ts）。
 */
import type {
  TableDef,
  ColumnDef,
  ConstraintDef,
} from "../vendor/ts-grm.js";

/** 数据库 schema（一个数据库连接的完整结构） */
export interface Schema {
  /** 表集合；表名使用数据库实际存储的名字（不折叠大小写） */
  readonly tables: ReadonlyArray<Table>;
}

/** 表：继承原生 TableDef，去掉模型语义与建表方法，约束/索引为迁移扩展后的形态 */
export interface Table extends Omit<
  TableDef,
  | "entity"
  | "prop"
  | "columns"
  | "constraints"
  | "toCreationStatements"
  | "toDeletionStatements"
> {
  readonly columns: ReadonlyArray<Column>;
  readonly constraints: ReadonlyArray<Constraint>;
  /** migrate 扩展：索引。ts-grm 模型无此概念，来源：补充声明 / introspection */
  readonly indexes: ReadonlyArray<Index>;
}

/**
 * 列：继承原生 ColumnDef，去掉模型引用与 ScalarType 类型，type 用方言原生字符串。
 * precision / scale 一并去掉：该信息已编码进方言类型字符串（如 "numeric(10,2)"），
 * migrate 的 IR 不重复承载，避免两处表达同一事实而漂移。
 */
export interface Column extends Omit<
  ColumnDef,
  | "declaringTable"
  | "prop"
  | "type"
  | "when"
  | "precision"
  | "scale"
> {
  /** 方言原生类型，如 "bigint" / "text" / "varchar(50)" / "numeric(10,2)" */
  readonly type: string;
  /** 默认值表达式原文（introspection 读到什么存什么，如 "nextval('t_id_seq'::regclass)"） */
  readonly default: string | undefined;
  /** 是否自增（identity / serial）——方言差异：PG 靠 default 或 attidentity，MySQL 靠 extra */
  readonly autoIncrement: boolean;
  /** 列在表中的序号（从 1 开始），方言重建表时需要，diff 时忽略 */
  readonly ordinal: number;
  readonly comment: string | undefined;
  /** SQL Server named DEFAULT constraint, retained for ALTER/DROP COLUMN. */
  readonly defaultConstraint?: string;
  readonly collation?: string;
  /** MySQL attributes retained when MODIFY restates a whole column definition. */
  readonly mysql?: {
    readonly charset?: string;
    readonly collation?: string;
    readonly onUpdate?: string;
  };
}

export type Constraint =
  | PrimaryKeyConstraint
  | UniqueConstraint
  | ForeignKeyConstraint
  | CheckConstraint;

/** 主键：继承原生 PRIMARY_KEY 定义（注意：原生 kind 是 "PRIMARY_KEY" | "INDEX" 联合），列改为名字集合 */
export interface PrimaryKeyConstraint extends Omit<
  Extract<ConstraintDef, { readonly kind: "PRIMARY_KEY" | "INDEX" }>,
  "kind" | "columns"
> {
  readonly kind: "PRIMARY_KEY";
  readonly name: string | undefined;
  readonly columns: ReadonlyArray<string>;
}

/** 唯一约束：继承原生 UNIQUE 定义，列改为名字集合 */
export interface UniqueConstraint extends Omit<
  Extract<ConstraintDef, { readonly kind: "UNIQUE" }>,
  "columns"
> {
  readonly name: string | undefined;
  readonly columns: ReadonlyArray<string>;
}

export type OnDelete =
  | "NO_ACTION"
  | "RESTRICT"
  | "CASCADE"
  | "SET_NULL"
  | "SET_DEFAULT";

/** 外键：继承原生 FOREIGN_KEY 定义（含 cascade / implicit），引用目标改为表名 + 列名 */
export interface ForeignKeyConstraint extends Omit<
  Extract<ConstraintDef, { readonly kind: "FOREIGN_KEY" }>,
  "columns" | "referencedColumns"
> {
  readonly name: string | undefined;
  /** 本表列 */
  readonly columns: ReadonlyArray<string>;
  /** 被引用表名 */
  readonly referencedTable: string;
  /** 被引用列 */
  readonly referencedColumns: ReadonlyArray<string>;
  /** 由原生 cascade 归一化的删除动作（适配器填充） */
  readonly onDelete: OnDelete;
  /** PG 特有：延迟约束（模型侧无来源，introspection 读 condeferrable） */
  readonly deferrable: boolean;
}

/** 检查约束：继承原生 CHECK 定义（column+values 保留），expression 供 DDL 直接使用 */
export interface CheckConstraint extends Omit<
  Extract<ConstraintDef, { readonly kind: "CHECK" }>,
  "column"
> {
  readonly name: string | undefined;
  /** 条件表达式原文（如 `"TYPE" in ('Book', 'PaperBook')`） */
  readonly expression: string;
  /** Dialect-normalized comparison form; expression remains executable SQL. */
  readonly comparisonExpression?: string;
}

export interface Index {
  /** Database-required supporting index, not an independently managed model index. */
  readonly implicit?: boolean;
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
  /** 部分索引（PG）的谓词表达式 */
  readonly predicate: string | undefined;
}

/** 便捷构造：空 schema */
export function emptySchema(): Schema {
  return { tables: [] };
}
