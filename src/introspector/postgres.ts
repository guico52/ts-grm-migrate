/**
 * Postgres Introspector —— 从 pg_catalog 读取数据库现状，产出 migrate 的 `Schema`。
 *
 * 对应 prisma-engines 的 `sql-schema-describer`（Postgres 实现）。
 *
 * 设计要点：
 *
 * 1. **类型字符串必须与 ts-grm 的 `PostgresDriver.typeName()` 对齐**
 *    （`packages/sql/src/driver/postgres_driver.ts:293`）。否则「模型建的表」与
 *    introspection 结果永不相等，diff 每次都会误判成类型变更。实测 `format_type()`
 *    有两处写法差异需要归一化：
 *    - `timestamp with time zone` vs ts-grm 的 `timestamptz`
 *    - `numeric(10,2)` vs ts-grm 的 `numeric(10, 2)`（逗号后有空格）
 *
 * 2. 只读目标 schema（默认 `public`），不碰系统 catalog。
 *
 * 3. 索引只收「独立索引」：主键索引与约束背后的索引由约束表达，不重复计入 `Index`
 *    （否则 UNIQUE 约束会同时以约束和索引出现两次，diff 每次都误判）。
 *
 * 4. 错误处理：introspection 是外部输入路径，查询失败包成带 schema 名的可读错误
 *    （见 docs/design.md 设计决策，不 fail-fast）。
 *
 * 5. pg 驱动只对已注册解析器的类型做数组解析：`array_agg(attname)` 的类型是 `name[]`，
 *    会被原样返回成 `"{A,B}"` 字符串（实测）。SQL 里统一 `::text` 转型规避，
 *    `asStringArray` 再兜一层（见该函数注释）。
 *
 * 已知限制：
 * - CHECK 的表达式原文（`pg_get_constraintdef`）与模型侧适配器还原的写法不同
 *   （PG 会 deparse 成 `((col)::text = ANY (ARRAY[...]))`），diff 会判为变化并
 *   drop+add；归一化留待后续（见 `src/differ.ts` 注释）。
 * - 暂不处理分区表（`relkind = 'p'`）与排他约束。
 */
import type { CascadeType } from "@ts-grm/core";
import type { Dialect, Introspector, SqlQueryable } from "../introspector.js";
import type {
  Column,
  Constraint,
  Index,
  OnDelete,
  Schema,
} from "../schema/model.js";

export interface PostgresIntrospectorOptions {
  /** 数据库查询能力（通常传 pg 的 Pool / Client） */
  readonly query: SqlQueryable;
  /** 目标 schema 名，默认 "public" */
  readonly schema?: string;
}

export class PostgresIntrospector implements Introspector {
  readonly dialect: Dialect = "postgres";

  constructor(private readonly _options: PostgresIntrospectorOptions) {}

  async introspect(): Promise<Schema> {
    const schemaName = this._options.schema ?? "public";
    const { query } = this._options;
    try {
      // 串行执行：调用方可能传单个连接（pg 的 Client），并发查同一连接是未定义行为
      // （pg 会警告 "client is already executing a query"）。introspection 是低频操作，
      // 串行换取「不要求调用方必须提供连接池」的健壮性。
      const tables = await query.query(TABLES_SQL, [schemaName]);
      const columns = await query.query(COLUMNS_SQL, [schemaName]);
      const constraints = await query.query(CONSTRAINTS_SQL, [schemaName]);
      const indexes = await query.query(INDEXES_SQL, [schemaName]);
      return assemble(
        tables.rows,
        columns.rows,
        constraints.rows,
        indexes.rows,
      );
    } catch (e) {
      throw new Error(
        `Postgres 结构读取失败（schema "${schemaName}"）：${(e as Error).message}`,
      );
    }
  }
}

// ---- SQL -------------------------------------------------------------------

/** 普通表（relkind = 'r'）；分区表 'p' 与视图暂不纳入 */
const TABLES_SQL = `
select c.relname as name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relkind = 'r'
order by c.relname
`;

const COLUMNS_SQL = `
select
  c.relname as table_name,
  a.attname as name,
  format_type(a.atttypid, a.atttypmod) as type,
  not a.attnotnull as nullable,
  a.attnum as ordinal,
  pg_get_expr(d.adbin, d.adrelid) as default_expr,
  a.attidentity as identity,
  col_description(c.oid, a.attnum) as comment
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = $1
  and c.relkind = 'r'
  and a.attnum > 0
  and not a.attisdropped
order by c.relname, a.attnum
`;

/**
 * contype: p=主键 u=唯一 f=外键 c=CHECK（x=排他，暂不纳入）
 * confdeltype: a=no action r=restrict c=cascade n=set null d=set default
 */
const CONSTRAINTS_SQL = `
select
  c.relname as table_name,
  con.conname as name,
  con.contype as kind,
  con.condeferrable as deferrable,
  con.confdeltype as delete_action,
  pg_get_constraintdef(con.oid) as definition,
  (
    select array_agg(a.attname::text order by k.ord)
    from unnest(con.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
  ) as columns,
  fc.relname as referenced_table,
  (
    select array_agg(a.attname::text order by k.ord)
    from unnest(con.confkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
  ) as referenced_columns
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_class fc on fc.oid = con.confrelid
where n.nspname = $1
  and con.contype in ('p', 'u', 'f', 'c')
order by c.relname, con.conname
`;

/** 独立索引：排除主键索引与约束背后的索引（那些由约束表达） */
const INDEXES_SQL = `
select
  c.relname as table_name,
  i.relname as name,
  ix.indisunique as is_unique,
  pg_get_expr(ix.indpred, ix.indrelid) as predicate,
  (
    select array_agg(a.attname::text order by k.ord)
    from unnest(ix.indkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
  ) as columns
from pg_index ix
join pg_class i on i.oid = ix.indexrelid
join pg_class c on c.oid = ix.indrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1
  and c.relkind = 'r'
  and not ix.indisprimary
  and not exists (
    select 1 from pg_constraint con where con.conindid = ix.indexrelid
  )
order by c.relname, i.relname
`;

// ---- 组装 -------------------------------------------------------------------

type Row = Record<string, unknown>;

function assemble(
  tableRows: ReadonlyArray<Row>,
  columnRows: ReadonlyArray<Row>,
  constraintRows: ReadonlyArray<Row>,
  indexRows: ReadonlyArray<Row>,
): Schema {
  const columnsByTable = new Map<string, Array<Column>>();
  for (const row of columnRows) {
    const table = asString(row["table_name"]);
    const list = columnsByTable.get(table) ?? [];
    list.push(toColumn(row));
    columnsByTable.set(table, list);
  }

  const constraintsByTable = new Map<string, Array<Constraint>>();
  for (const row of constraintRows) {
    const constraint = toConstraint(row);
    if (constraint == null) {
      continue;
    }
    const table = asString(row["table_name"]);
    const list = constraintsByTable.get(table) ?? [];
    list.push(constraint);
    constraintsByTable.set(table, list);
  }

  const indexesByTable = new Map<string, Array<Index>>();
  for (const row of indexRows) {
    const table = asString(row["table_name"]);
    const list = indexesByTable.get(table) ?? [];
    list.push(toIndex(row));
    indexesByTable.set(table, list);
  }

  return {
    tables: tableRows.map((row) => {
      const name = asString(row["name"]);
      return {
        name,
        columns: columnsByTable.get(name) ?? [],
        constraints: constraintsByTable.get(name) ?? [],
        indexes: indexesByTable.get(name) ?? [],
      };
    }),
  };
}

function toColumn(row: Row): Column {
  const defaultExpr = row["default_expr"] == null ? undefined : asString(row["default_expr"]);
  const identity = asString(row["identity"]);
  return {
    name: asString(row["name"]),
    type: normalizeType(asString(row["type"])),
    nullable: row["nullable"] === true,
    // 长度/精度已编码在 type 字符串里（"varchar(50)" / "numeric(10, 2)"），不重复承载
    length: undefined,
    default: defaultExpr,
    // identity 列（generated ... as identity）或 serial（默认值 nextval）都算自增
    autoIncrement:
      identity === "a" ||
      identity === "d" ||
      (defaultExpr?.startsWith("nextval(") ?? false),
    ordinal: Number(row["ordinal"]),
    comment: row["comment"] == null ? undefined : asString(row["comment"]),
  };
}

function toConstraint(row: Row): Constraint | null {
  const name = asString(row["name"]);
  const columns = asStringArray(row["columns"]);
  switch (asString(row["kind"])) {
    case "p":
      return { kind: "PRIMARY_KEY", name, columns, implicit: undefined };
    case "u":
      return { kind: "UNIQUE", name, columns, implicit: undefined };
    case "f": {
      const onDelete = toOnDelete(asString(row["delete_action"]));
      return {
        kind: "FOREIGN_KEY",
        name,
        columns,
        referencedTable: asString(row["referenced_table"]),
        referencedColumns: asStringArray(row["referenced_columns"]),
        onDelete,
        deferrable: row["deferrable"] === true,
        // ORM 侧级联语义在数据库里不可见，由 ON DELETE 反推（diff 只比较 onDelete）
        cascade: toCascade(onDelete),
        implicit: undefined,
      };
    }
    case "c":
      return {
        kind: "CHECK",
        name,
        // PG 的 CHECK 是任意表达式，不是「列 in 值集」；values 无对应来源
        values: [],
        expression: checkExpression(asString(row["definition"])),
        implicit: undefined,
      };
    default:
      // 排他约束等：migrate 的 IR 不表达，跳过
      return null;
  }
}

function toIndex(row: Row): Index {
  return {
    name: asString(row["name"]),
    columns: asStringArray(row["columns"]),
    unique: row["is_unique"] === true,
    predicate: row["predicate"] == null ? undefined : asString(row["predicate"]),
  };
}

// ---- 归一化 -----------------------------------------------------------------

/**
 * 把 `format_type()` 的输出规范成与 ts-grm `PostgresDriver.typeName()` 一致的写法。
 * 只做「等价写法」归一化，不改变语义 —— 见文件头注释第 1 点。
 */
export function normalizeType(raw: string): string {
  if (raw === "timestamp with time zone") {
    return "timestamptz";
  }
  const numeric = /^numeric\((\d+),(\d+)\)$/.exec(raw);
  if (numeric != null) {
    return `numeric(${numeric[1]}, ${numeric[2]})`;
  }
  return raw;
}

/** `${'CHECK ((expr))'}` → `expr`（剥掉前缀与最外层括号） */
function checkExpression(definition: string): string {
  const prefix = "CHECK ";
  if (!definition.startsWith(prefix)) {
    return definition;
  }
  const body = definition.slice(prefix.length).trim();
  if (body.startsWith("(") && body.endsWith(")")) {
    return body.slice(1, -1);
  }
  return body;
}

/** pg 的 confdeltype → migrate 的 OnDelete */
function toOnDelete(code: string): OnDelete {
  switch (code) {
    case "c":
      return "CASCADE";
    case "n":
      return "SET_NULL";
    case "d":
      return "SET_DEFAULT";
    case "r":
      return "RESTRICT";
    default:
      return "NO_ACTION";
  }
}

/** migrate 的 OnDelete → ts-grm 的 ORM 级联语义（introspection 只能反推） */
function toCascade(onDelete: OnDelete): CascadeType {
  switch (onDelete) {
    case "CASCADE":
      return "DELETE";
    case "SET_NULL":
      return "SET_NULL";
    default:
      return "NONE";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asStringArray(value: unknown): Array<string> {
  if (Array.isArray(value)) {
    return value.map((v) => asString(v));
  }
  // 实测：pg 只对已注册解析器的数组类型（如 text[]）返回 JS 数组；
  // array_agg(attname) 的类型是 name[]，会被原样返回成 "{a,b}" 字符串。
  // SQL 里已用 ::text 规避，这里再兜一层（introspection 是外部输入路径）。
  if (typeof value === "string") {
    return parsePgArrayLiteral(value);
  }
  return [];
}

/** 解析 PG 数组字面量（`{a,b}` / `{"a b",c}`）；空数组 `{}` → [] */
function parsePgArrayLiteral(raw: string): Array<string> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return [];
  }
  const body = trimmed.slice(1, -1);
  if (body === "") {
    return [];
  }
  return body.split(",").map((item) => {
    const s = item.trim();
    return s.startsWith('"') && s.endsWith('"')
      ? s.slice(1, -1).replaceAll('""', '"')
      : s;
  });
}
