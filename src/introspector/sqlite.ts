import { sqliteChecks, sqlTokens } from "../schema/checks.js";
import { diagnostic, asError } from "../diagnostics/error.js";
/**
 * SQLite 版 Introspector。
 *
 * 用 `sqlite_master` + `pragma` 读取结构（SQLite 没有 information_schema）。
 * 与 Postgres 版的关键差异：
 *
 * 1. **没有 schema 概念**（只有 main / attached），因此没有 schema 选项；
 * 2. **没有约束名**。SQLite 语法上接受 `constraint <名字> primary key(...)`，
 *    但不把它存进 catalog —— pragma 读不到任何约束名。因此这里一律给
 *    `name: undefined`。这不影响正确性：diff 按**内容**匹配约束
 *    （见 docs/design.md 的设计决策），名字本就不参与比较；
 * 3. 主键从 `pragma table_info` 的 `pk` 列取，**不能**靠 `pragma index_list`
 *    —— `integer primary key` 是 rowid 别名，SQLite 不为它建索引。
 * 4. 是否显式 AUTOINCREMENT 只能从 `sqlite_master.sql` 的原文判断
 *    （pragma 不暴露这个关键字）：migrate 生成的 `INTEGER PRIMARY KEY AUTOINCREMENT`
 *    会被读回 `autoIncrement: true`，与模型侧声明对齐。
 *
 * 类型字符串必须与 ts-grm `SqliteDriver.typeName()` 对齐（只产出
 * text / integer / real / blob），否则差分会永远不相等 —— 见 `normalizeSqliteType`。
 *
 * introspection 是外部输入路径：出错包成带上下文的可读错误，不 fail-fast。
 */
import type { CascadeType } from "../vendor/ts-grm.js";
import type { Column, Constraint, ForeignKeyConstraint, Index, OnDelete, Schema, Table } from "../schema/model.js";
import type { Dialect, Introspector, SqlQueryable } from "../introspector.js";

export interface SqliteIntrospectorOptions {
  readonly query: SqlQueryable;
}

/** 表清单（排除 SQLite 内部表）；同时取建表原文，用于识别 AUTOINCREMENT */
const TABLES_SQL = `
select name, sql
from sqlite_master
where type = 'table' and name not like 'sqlite_%'
order by name
`;

export class SqliteIntrospector implements Introspector {
  readonly dialect: Dialect = "sqlite";

  constructor(private readonly _options: SqliteIntrospectorOptions) {}

  async introspect(): Promise<Schema> {
    const { query } = this._options;
    try {
      const tableRows = await query.query(TABLES_SQL);
      const tables: Array<Table> = [];
      for (const row of tableRows.rows) {
        const name = asString(row["name"]);
        const definitionTokens = sqlTokens(asString(row["sql"])).filter(token => token !== ";");
        const specialDeclaration = definitionTokens.some((token, i) =>
          (token.toLowerCase() === "deferrable" && definitionTokens[i - 1]?.toLowerCase() !== "not") ||
          token.toLowerCase() === "collate" ||
          (token.toLowerCase() === "virtual" && definitionTokens[i + 1]?.toLowerCase() === "table")
        );
        if (specialDeclaration || definitionTokens.slice(-2).join(" ").toLowerCase() === "without rowid" || definitionTokens.at(-1)?.toLowerCase() === "strict") {
          throw diagnostic("unsupported_structure", name, diagnostic("structure_table"));
        }
        // AUTOINCREMENT 只存于建表原文；SQLite 只允许它出现在单列 INTEGER 主键上
        const autoIncrement = definitionTokens.some(token => token.toLowerCase() === "autoincrement");
        const { columns, primaryKey } = await this._columns(name, autoIncrement);
        const foreignKeys = await this._foreignKeys(name);
        const { uniques, indexes } = await this._indexes(name);
        tables.push({
          name,
          columns,
          constraints: [...primaryKey, ...uniques, ...foreignKeys, ...sqliteChecks(asString(row["sql"])).map(expression => ({ kind: "CHECK" as const, name: undefined, expression, values: [], implicit: undefined }))],
          indexes,
        });
      }
      return { tables };
    } catch (e) {
      throw diagnostic("introspector_sqlite_1", asError(e));
    }
  }

  /**
   * 列与主键。
   * `table_info` 的 `pk` 列给出该列在复合主键中的位置（0 = 非主键），
   * 据此还原主键并保持列序。
   */
  private async _columns(
    table: string,
    autoIncrement: boolean,
  ): Promise<{ columns: Array<Column>; primaryKey: Array<Constraint> }> {
    const { rows } = await this._options.query.query(`pragma table_xinfo(${quoteForPragma(table)})`);
    if (rows.some(row => Number(row["hidden"] ?? 0) !== 0)) throw diagnostic("unsupported_structure", table, diagnostic("structure_column"));
    const pkColumns: Array<{ name: string; position: number }> = [];
    const columns = rows.map((row) => {
      const name = asString(row["name"]);
      const pkPosition = Number(row["pk"]);
      if (pkPosition > 0) {
        pkColumns.push({ name, position: pkPosition });
      }
      return {
        name,
        type: normalizeSqliteType(asString(row["type"])),
        nullable: Number(row["notnull"]) === 0,
        // 长度已编码在类型里（SQLite 一般不写），不重复承载
        length: undefined,
        default: row["dflt_value"] == null ? undefined : asString(row["dflt_value"]),
        // AUTOINCREMENT 只能加在主键列上（见文件头第 4 点）
        autoIncrement: autoIncrement && pkPosition > 0,
        ordinal: Number(row["cid"]) + 1,
        comment: undefined,
      };
    });
    pkColumns.sort((a, b) => a.position - b.position);
    const primaryKey: Array<Constraint> =
      pkColumns.length === 0
        ? []
        : [
            {
              kind: "PRIMARY_KEY",
              // catalog 不保存约束名，见文件头第 2 点
              name: undefined,
              columns: pkColumns.map((c) => c.name),
              implicit: undefined,
            },
          ];
    return { columns, primaryKey };
  }

  /** 外键：复合键在 pragma 里是同一 id 的多行，按 id 归组、按 seq 排序 */
  private async _foreignKeys(table: string): Promise<Array<ForeignKeyConstraint>> {
    const { rows } = await this._options.query.query(
      `pragma foreign_key_list(${quoteForPragma(table)})`,
    );
    const byId = new Map<number, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const id = Number(row["id"]);
      const group = byId.get(id);
      if (group == null) {
        byId.set(id, [row]);
      } else {
        group.push(row);
      }
    }
    const result: Array<ForeignKeyConstraint> = [];
    for (const group of byId.values()) {
      const ordered = [...group].sort((a, b) => Number(a["seq"]) - Number(b["seq"]));
      const onDelete = toOnDelete(asString(ordered[0]!["on_delete"]));
      if (asString(ordered[0]!["on_update"]).toUpperCase() !== "NO ACTION") throw diagnostic("unsupported_structure", table, diagnostic("structure_constraint"));
      let referencedColumns = ordered.map(r => asString(r["to"]));
      if (ordered.every(r => r["to"] == null)) {
        const parent = asString(ordered[0]!["table"]);
        const primary = await this._options.query.query(`pragma table_xinfo(${quoteForPragma(parent)})`);
        referencedColumns = primary.rows.filter(r => Number(r["pk"]) > 0).sort((a, b) => Number(a["pk"]) - Number(b["pk"])).map(r => asString(r["name"]));
        if (referencedColumns.length !== ordered.length) throw diagnostic("unsupported_structure", table, diagnostic("structure_missing_key"));
      }
      result.push({
        kind: "FOREIGN_KEY",
        name: undefined,
        columns: ordered.map((r) => asString(r["from"])),
        referencedTable: asString(ordered[0]!["table"]),
        // An omitted reference column list denotes the parent primary key.
        referencedColumns,
        onDelete,
        deferrable: false,
        // ORM 侧级联语义在数据库里不可见，由 ON DELETE 反推（与 PG 版同口径）
        cascade: toCascade(onDelete),
        implicit: undefined,
      });
    }
    return result;
  }

  /**
   * 索引与唯一约束。
   *
   * `pragma index_list` 的 origin 区分来源：
   * - `c` = create index（我们意义上的索引）
   * - `u` = unique 约束（表级 UNIQUE）
   * - `pk` = 主键，跳过（主键从 table_info 取，避免重复表示）
   */
  private async _indexes(
    table: string,
  ): Promise<{ uniques: Array<Constraint>; indexes: Array<Index> }> {
    const { rows } = await this._options.query.query(
      `pragma index_list(${quoteForPragma(table)})`,
    );
    const uniques: Array<Constraint> = [];
    const indexes: Array<Index> = [];
    for (const row of rows) {
      const name = asString(row["name"]);
      const origin = asString(row["origin"]);
      if (origin === "pk") {
        const details = await this._options.query.query(`pragma index_xinfo(${quoteForPragma(name)})`);
        if (details.rows.some(r => Number(r["key"]) === 1 && (Number(r["desc"]) !== 0 || asString(r["coll"]).toUpperCase() !== "BINARY"))) throw diagnostic("unsupported_structure", table, diagnostic("structure_constraint"));
        continue;
      }
      const columns = await this._indexColumns(name);
      const definition = await this._options.query.query(`select sql from sqlite_master where type = 'index' and name = ${"'" + name.replaceAll("'", "''") + "'"}`);
      const tokens = sqlTokens(asString(definition.rows[0]?.["sql"]));
      const indexDetails = await this._options.query.query(`pragma index_xinfo(${quoteForPragma(name)})`);
      const unsupported = indexDetails.rows.some(r => Number(r["key"]) === 1 && (Number(r["cid"]) < 0 || Number(r["desc"]) !== 0 || asString(r["coll"]).toUpperCase() !== "BINARY"));
      const where = tokens.findIndex(t => t.toLowerCase() === "where");
      if (origin === "u") {
        if (unsupported) throw diagnostic("unsupported_structure", `${table}.${name}`, diagnostic("structure_constraint"));
        uniques.push({ kind: "UNIQUE", name: undefined, columns, implicit: undefined });
      } else {
        indexes.push({
          name,
          ...(unsupported ? { unsupported: "SQLITE_SPECIAL_INDEX" } : {}),
          columns,
          unique: Number(row["unique"]) === 1,
          // Partial predicates are retained even when the model does not manage indexes.
          predicate: where < 0 ? undefined : tokens.slice(where + 1).join(" "),
        });
      }
    }
    return { uniques, indexes };
  }

  private async _indexColumns(index: string): Promise<Array<string>> {
    const { rows } = await this._options.query.query(
      `pragma index_info(${quoteForPragma(index)})`,
    );
    return [...rows]
      .sort((a, b) => Number(a["seqno"]) - Number(b["seqno"]))
      .map((r) => asString(r["name"]));
  }
}

/** pragma 不支持参数绑定，标识符只能拼接 —— 双引号包裹并把内部双引号翻倍 */
function quoteForPragma(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * SQLite 的声明类型 → ts-grm `SqliteDriver.typeName()` 的输出。
 *
 * SQLite 的类型系统是「亲和性」而非强类型（列上可以写任意类型名），而 ts-grm
 * 只会产出四种（见 `sqlite_driver.ts` 的 typeName）。归一化保证
 * 「模型建的表 == introspection 读到的」自洽，否则差分会永远不相等。
 */
export function normalizeSqliteType(raw: string): string {
  const t = raw.trim().toLowerCase();
  // 未声明类型 → BLOB 亲和性
  if (t === "") {
    return "blob";
  }
  if (t.includes("int")) {
    return "integer";
  }
  if (t.includes("char") || t.includes("clob") || t.includes("text")) {
    return "text";
  }
  if (t.includes("blob")) {
    return "blob";
  }
  if (t.includes("real") || t.includes("floa") || t.includes("doub")) {
    return "real";
  }
  // @see https://www.sqlite.org/datatype3.html §3.1
  // NUMERIC affinity differs from REAL and must remain observable.
  return "numeric";
}

/** SQLite 的 on_delete 文本 → migrate 的 OnDelete */
function toOnDelete(raw: string): OnDelete {
  switch (raw.toUpperCase()) {
    case "CASCADE":
      return "CASCADE";
    case "SET NULL":
      return "SET_NULL";
    case "SET DEFAULT":
      return "SET_DEFAULT";
    case "RESTRICT":
      return "RESTRICT";
    default:
      return "NO_ACTION";
  }
}

/** migrate 的 OnDelete → ts-grm 的 ORM 级联语义（introspection 只能反推，与 PG 版同口径） */
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
  return value == null ? "" : String(value);
}
