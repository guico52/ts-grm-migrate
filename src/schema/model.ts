/**
 * 迁移引擎的「数据库 schema 中间表示」。
 *
 * 设计要点（对应 prisma-engines 的 `database_schema.rs` / `sql_schema_describer`）：
 *
 * 1. 这个表示是「语义层」的：diff 在语义层做（模型 schema vs 数据库 schema 都是这个形状），
 *    DDL 生成在语法层做（方言把这里的字段翻译成具体 SQL）。不要试图让这个模型直接表达方言细节。
 *
 * 2. 类型字段 `type` 用「方言原生类型字符串」（如 "bigint" / "text" / "varchar(50)"），
 *    而不是抽象枚举——因为 introspector 从数据库读到的就是原生类型，
 *    而模型侧（ts-grm 的 ScalarType）转成原生类型由各方言的 typeName() 负责。
 *    将来如果要跨方言比较，再加一层归一化映射。
 *
 * 3. 显式携带 `comment`（迁移注记用），并预留 `ordinal`（列序号）供方言重建表时用，
 *    但 diff 必须忽略列顺序差异（PG/SQLite 都无法在 alter 里调列序）。
 *
 * 4. 与 ts-grm `packages/sql/src/impl/schema_def.ts` 的 TableDef 的关系：
 *    - TableDef 是「从模型推导的」目标态，带多态/继承语义（implicit 约束、when 条件列）；
 *    - 本模块的 Schema 是「任意来源」的（模型推导或数据库 introspection），
 *      不含多态语义 —— 多态语义的丢失（when 列 -> 普通 nullable 列）由模型侧适配器负责归一化。
 */

/** 数据库 schema（一个数据库连接的完整结构） */
export interface Schema {
  /** 表名 -> 表；表名使用数据库实际存储的名字（不折叠大小写） */
  readonly tables: ReadonlyMap<string, Table>;
}

export interface Table {
  readonly name: string;
  readonly columns: ReadonlyArray<Column>;
  readonly constraints: ReadonlyArray<Constraint>;
  readonly indexes: ReadonlyArray<Index>;
}

export interface Column {
  readonly name: string;
  /** 方言原生类型，如 "bigint" / "text" / "varchar(50)" / "numeric(10,2)" */
  readonly type: string;
  readonly nullable: boolean;
  /** 默认值表达式原文（introspection 读到什么存什么，如 "nextval('t_id_seq'::regclass)"） */
  readonly default: string | undefined;
  /** 是否自增（identity / serial）——方言差异：PG 靠 default 或 attidentity，MySQL 靠 extra */
  readonly autoIncrement: boolean;
  /** 列在表中的序号（从 1 开始），方言重建表时需要，diff 时忽略 */
  readonly ordinal: number;
  readonly comment: string | undefined;
}

export type Constraint =
  | PrimaryKeyConstraint
  | UniqueConstraint
  | ForeignKeyConstraint
  | CheckConstraint;

export interface PrimaryKeyConstraint {
  readonly kind: "PRIMARY_KEY";
  readonly name: string | undefined;
  readonly columns: ReadonlyArray<string>;
}

export interface UniqueConstraint {
  readonly kind: "UNIQUE";
  readonly name: string | undefined;
  readonly columns: ReadonlyArray<string>;
}

export type OnDelete =
  | "NO_ACTION"
  | "RESTRICT"
  | "CASCADE"
  | "SET_NULL"
  | "SET_DEFAULT";

export interface ForeignKeyConstraint {
  readonly kind: "FOREIGN_KEY";
  readonly name: string | undefined;
  /** 本表列 */
  readonly columns: ReadonlyArray<string>;
  /** 被引用表名 */
  readonly referencedTable: string;
  /** 被引用列 */
  readonly referencedColumns: ReadonlyArray<string>;
  readonly onDelete: OnDelete;
  /** PG 特有：延迟约束（confdeltype 之外还有 condeferrable） */
  readonly deferrable: boolean;
}

export interface CheckConstraint {
  readonly kind: "CHECK";
  readonly name: string | undefined;
  /** 条件表达式原文（如 `("TYPE" = ANY (ARRAY['Book'::text, 'PaperBook'::text]))`） */
  readonly expression: string;
}

export interface Index {
  readonly name: string;
  readonly columns: ReadonlyArray<string>;
  readonly unique: boolean;
  /** 部分索引（PG）的谓词表达式 */
  readonly predicate: string | undefined;
}

/** 便捷构造：空 schema */
export function emptySchema(): Schema {
  return { tables: new Map() };
}
