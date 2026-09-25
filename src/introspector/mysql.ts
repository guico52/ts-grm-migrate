import type { Introspector, SqlQueryable } from "../introspector.js";
import type { Column, Constraint, ForeignKeyConstraint, Index, OnDelete, Schema } from "../schema/model.js";
import { normalizeMysqlCheck, normalizeMysqlType, quoteMysqlLiteral } from "../mysql/sql.js";

type Row = Record<string, unknown>;
const str = (value: unknown): string => String(value ?? "");

/**
 * MySQL 8.0.16+ / InnoDB catalog reader. Catalog names are bound, never interpolated.
 * @see https://dev.mysql.com/doc/refman/8.4/en/information-schema.html
 */
export class MysqlIntrospector implements Introspector {
  readonly dialect = "mysql" as const;
  constructor(private readonly _options: { readonly query: SqlQueryable }) {}

  async introspect(): Promise<Schema> {
    const query = async (sql: string): Promise<ReadonlyArray<Row>> => (await this._options.query.query(sql)).rows;
    try {
      const tables = await query("select TABLE_NAME as name, ENGINE as engine from information_schema.TABLES where TABLE_SCHEMA = database() and TABLE_TYPE = 'BASE TABLE' order by TABLE_NAME");
      const columns = await query("select * from information_schema.COLUMNS where TABLE_SCHEMA = database() order by TABLE_NAME, ORDINAL_POSITION");
      const keys = await query(`select tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, k.COLUMN_NAME,
        k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
        rc.DELETE_RULE, rc.UPDATE_RULE, cc.CHECK_CLAUSE, tc.ENFORCED
        from information_schema.TABLE_CONSTRAINTS tc
        left join information_schema.KEY_COLUMN_USAGE k on k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          and k.TABLE_NAME = tc.TABLE_NAME and k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        left join information_schema.REFERENTIAL_CONSTRAINTS rc on rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          and rc.TABLE_NAME = tc.TABLE_NAME and rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        left join information_schema.CHECK_CONSTRAINTS cc on cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          and cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        where tc.CONSTRAINT_SCHEMA = database() order by tc.TABLE_NAME, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`);
      const indexes = await query("select * from information_schema.STATISTICS where TABLE_SCHEMA = database() order by TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX");
      const db = str((await query("select database() as name"))[0]?.name);
      return { tables: tables.map((table) => {
        const name = str(table.name);
        if (table.engine !== "InnoDB") throw new Error(`Table ${name} uses ${str(table.engine)}; only InnoDB is supported`);
        const constraints = this._constraints(keys.filter((r) => r.TABLE_NAME === name), db);
        return {
          name,
          columns: columns.filter((r) => r.TABLE_NAME === name).map((r) => this._column(r)),
          constraints,
          indexes: this._indexes(indexes.filter((r) => r.TABLE_NAME === name), constraints),
        };
      }) };
    } catch (e) {
      throw new Error(`Failed to introspect MySQL schema: ${(e as Error).message}`);
    }
  }

  private _column(row: Row): Column {
    const extra = str(row.EXTRA);
    if (str(row.GENERATION_EXPRESSION) || /invisible/i.test(extra)) {
      throw new Error(`Generated or hidden column ${str(row.TABLE_NAME)}.${str(row.COLUMN_NAME)} is not supported`);
    }
    const rawDefault = row.COLUMN_DEFAULT;
    let defaultValue: string | undefined;
    if (rawDefault != null) {
      if (/DEFAULT_GENERATED/i.test(extra)) {
        const expression = str(rawDefault);
        defaultValue = /^current_timestamp(?:\(\d*\))?$/i.test(expression) ? expression : `(${expression})`;
      } else {
        defaultValue = quoteMysqlLiteral(str(rawDefault));
      }
    }
    return {
      name: str(row.COLUMN_NAME), type: normalizeMysqlType(str(row.COLUMN_TYPE)),
      nullable: row.IS_NULLABLE === "YES", length: undefined,
      default: defaultValue, autoIncrement: /auto_increment/i.test(extra),
      ordinal: Number(row.ORDINAL_POSITION), comment: str(row.COLUMN_COMMENT) || undefined,
      // MODIFY must retain attributes the model does not manage.
      mysql: {
        charset: row.CHARACTER_SET_NAME == null ? undefined : str(row.CHARACTER_SET_NAME),
        collation: row.COLLATION_NAME == null ? undefined : str(row.COLLATION_NAME),
        onUpdate: extra.match(/on update (current_timestamp(?:\(\d*\))?)/i)?.[1],
      },
    };
  }

  private _constraints(rows: ReadonlyArray<Row>, database: string): Array<Constraint> {
    return [...group(rows, "CONSTRAINT_NAME").entries()].map(([name, entries]): Constraint => {
      const row = entries[0]!;
      const columns = entries.map((r) => str(r.COLUMN_NAME));
      switch (row.CONSTRAINT_TYPE) {
        case "PRIMARY KEY": return { kind: "PRIMARY_KEY", name, columns, implicit: undefined };
        case "UNIQUE": return { kind: "UNIQUE", name, columns, implicit: undefined };
        case "CHECK":
          if (row.ENFORCED === "NO") throw new Error(`CHECK ${name} is not enforced and cannot be migrated`);
          return { kind: "CHECK", name, expression: str(row.CHECK_CLAUSE), comparisonExpression: normalizeMysqlCheck(str(row.CHECK_CLAUSE)), values: [], implicit: undefined };
        case "FOREIGN KEY": {
          if (row.REFERENCED_TABLE_SCHEMA !== database) throw new Error(`Foreign key ${name} references another database, which is not supported`);
          if (!["NO ACTION", "RESTRICT"].includes(str(row.UPDATE_RULE))) throw new Error(`Foreign key ${name} uses unsupported ON UPDATE ${str(row.UPDATE_RULE)}`);
          const onDelete = deleteAction(str(row.DELETE_RULE));
          return {
            kind: "FOREIGN_KEY", name, columns, referencedTable: str(row.REFERENCED_TABLE_NAME),
            referencedColumns: entries.map((r) => str(r.REFERENCED_COLUMN_NAME)), onDelete,
            cascade: onDelete === "CASCADE" ? "DELETE" : onDelete === "SET_NULL" ? "SET_NULL" : "NONE",
            deferrable: false, implicit: undefined,
          };
        }
        default: throw new Error(`Unsupported MySQL constraint ${str(row.CONSTRAINT_TYPE)}`);
      }
    });
  }

  private _indexes(rows: ReadonlyArray<Row>, constraints: ReadonlyArray<Constraint>): Array<Index> {
    const foreignKeys = constraints.filter((c): c is ForeignKeyConstraint => c.kind === "FOREIGN_KEY");
    const result: Array<Index> = [];
    for (const [name, entries] of group(rows, "INDEX_NAME")) {
      if (entries.some((r) => r.SUB_PART != null || r.EXPRESSION != null || r.COLLATION === "D" || r.INDEX_TYPE !== "BTREE" || r.IS_VISIBLE === "NO")) {
        throw new Error(`Index ${name} uses a prefix, expression, descending, hidden or non-BTREE definition; migration is not supported`);
      }
      if (name === "PRIMARY" || Number(entries[0]!.NON_UNIQUE) === 0) continue;
      const columns = entries.map((r) => str(r.COLUMN_NAME));
      result.push({
        name, columns, unique: false, predicate: undefined,
        // InnoDB creates/supports FK indexes; they are not user-model drift.
        implicit: foreignKeys.some((fk) => fk.columns.every((c, i) => columns[i] === c)),
      });
    }
    return result;
  }
}

function group(rows: ReadonlyArray<Row>, key: string): Map<string, Array<Row>> {
  const groups = new Map<string, Array<Row>>();
  for (const row of rows) {
    const name = str(row[key]);
    const entries = groups.get(name) ?? [];
    entries.push(row); groups.set(name, entries);
  }
  return groups;
}
function deleteAction(value: string): OnDelete {
  switch (value) {
    case "CASCADE": return "CASCADE";
    case "SET NULL": return "SET_NULL";
    case "RESTRICT":
    case "NO ACTION": return "NO_ACTION";
    default: throw new Error(`Unsupported ON DELETE ${value}`);
  }
}
