import type { Introspector, SqlQueryable } from "../introspector.js";
import type {
  Column,
  Constraint,
  Index,
  OnDelete,
  Schema,
} from "../schema/model.js";
import {
  groupRows,
  stringValue as s,
  normalizeServerExpression,
  type CatalogRow as Row,
} from "../server/catalog.js";
import { normalizeServerType } from "../server/sql.js";

/** @see https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/catalog-views-transact-sql */
export class SqlServerIntrospector implements Introspector {
  readonly dialect = "mssql" as const;
  constructor(
    private readonly _options: {
      readonly query: SqlQueryable;
      readonly schema?: string;
    },
  ) {}

  async introspect(): Promise<Schema> {
    const schema = this._options.schema ?? "dbo";
    const query = async (sql: string): Promise<ReadonlyArray<Row>> =>
      (await this._options.query.query(sql, [schema])).rows;
    try {
      const tables =
        await query(`select t.name, t.temporal_type, t.is_memory_optimized from sys.tables t
        join sys.schemas s on s.schema_id=t.schema_id where s.name=@p1 and t.is_ms_shipped=0 order by t.name`);
      const columns =
        await query(`select t.name as table_name, c.name, ty.name as type_name, c.max_length, c.precision, c.scale,
        c.is_nullable, c.is_identity, c.is_computed, c.is_sparse, c.generated_always_type, c.is_hidden,
        c.column_id, c.collation_name, dc.name as default_name, dc.definition as default_value, ty.is_user_defined
        from sys.tables t join sys.schemas s on s.schema_id=t.schema_id
        join sys.columns c on c.object_id=t.object_id join sys.types ty on c.user_type_id=ty.user_type_id
        left join sys.default_constraints dc on c.default_object_id=dc.object_id
        where s.name=@p1 order by t.name,c.column_id`);
      const keys =
        await query(`select t.name as table_name,k.name,k.type,i.type as index_type,c.name as column_name,ic.key_ordinal
        from sys.key_constraints k join sys.tables t on t.object_id=k.parent_object_id join sys.schemas s on s.schema_id=t.schema_id
        join sys.indexes i on i.object_id=t.object_id and i.index_id=k.unique_index_id
        join sys.index_columns ic on ic.object_id=t.object_id and ic.index_id=k.unique_index_id
        join sys.columns c on c.object_id=t.object_id and c.column_id=ic.column_id
        where s.name=@p1 order by t.name,k.name,ic.key_ordinal`);
      const fks =
        await query(`select t.name as table_name,fk.name,c.name as column_name,rt.name as ref_table,
        rs.name as ref_schema,rc.name as ref_column,fk.delete_referential_action_desc as delete_rule,
        fk.update_referential_action_desc as update_rule,fk.is_disabled,fk.is_not_trusted
        from sys.foreign_keys fk join sys.tables t on t.object_id=fk.parent_object_id join sys.schemas s on s.schema_id=t.schema_id
        join sys.foreign_key_columns fc on fc.constraint_object_id=fk.object_id
        join sys.columns c on c.object_id=t.object_id and c.column_id=fc.parent_column_id
        join sys.tables rt on rt.object_id=fk.referenced_object_id join sys.schemas rs on rs.schema_id=rt.schema_id
        join sys.columns rc on rc.object_id=rt.object_id and rc.column_id=fc.referenced_column_id
        where s.name=@p1 order by t.name,fk.name,fc.constraint_column_id`);
      const checks =
        await query(`select t.name as table_name,c.name,c.definition,c.is_disabled,c.is_not_trusted
        from sys.check_constraints c join sys.tables t on t.object_id=c.parent_object_id
        join sys.schemas s on s.schema_id=t.schema_id where s.name=@p1`);
      const indexes =
        await query(`select t.name as table_name,i.name,i.type,i.is_unique,i.is_disabled,i.filter_definition,
        ic.is_descending_key,ic.is_included_column,ic.key_ordinal,c.name as column_name
        from sys.indexes i join sys.tables t on t.object_id=i.object_id join sys.schemas s on s.schema_id=t.schema_id
        join sys.index_columns ic on ic.object_id=t.object_id and ic.index_id=i.index_id
        join sys.columns c on c.object_id=t.object_id and c.column_id=ic.column_id
        where s.name=@p1 and i.is_primary_key=0 and i.is_unique_constraint=0 and i.is_hypothetical=0
        order by t.name,i.name,ic.key_ordinal`);
      return {
        tables: tables.map((t) => {
          const name = s(t.name);
          if (Number(t.temporal_type) !== 0 || t.is_memory_optimized)
            throw new Error(
              `Table ${name} is temporal or memory-optimized, which is not supported`,
            );
          const forTable = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
            rows.filter((r) => r.table_name === name);
          const constraints: Constraint[] = [];
          for (const [name, rows] of groupRows(forTable(keys), "name")) {
            const primary = rows[0]!.type === "PK";
            if (Number(rows[0]!.index_type) !== (primary ? 1 : 2))
              throw new Error(`Constraint ${name} uses a custom clustered layout, which is not supported`);
            constraints.push({
              kind: primary ? "PRIMARY_KEY" : "UNIQUE",
              name,
              columns: rows.map((r) => s(r.column_name)),
              implicit: undefined,
            });
          }
          for (const [name, rows] of groupRows(forTable(fks), "name")) {
            const first = rows[0]!;
            if (
              first.ref_schema !== schema ||
              first.update_rule !== "NO_ACTION" ||
              first.is_disabled ||
              first.is_not_trusted
            )
              throw new Error(
                `Foreign key ${name} crosses schemas, has an ON UPDATE action, or is disabled/untrusted; migration is not supported`,
              );
            const onDelete = s(first.delete_rule) as OnDelete;
            constraints.push({
              kind: "FOREIGN_KEY",
              name,
              columns: rows.map((r) => s(r.column_name)),
              referencedTable: s(first.ref_table),
              referencedColumns: rows.map((r) => s(r.ref_column)),
              onDelete,
              cascade:
                onDelete === "CASCADE"
                  ? "DELETE"
                  : onDelete === "SET_NULL"
                    ? "SET_NULL"
                    : "NONE",
              deferrable: false,
              implicit: undefined,
            });
          }
          for (const c of forTable(checks)) {
            if (c.is_disabled || c.is_not_trusted)
              throw new Error(`CHECK ${s(c.name)} is disabled or untrusted`);
            constraints.push({
              kind: "CHECK",
              name: s(c.name),
              expression: s(c.definition),
              comparisonExpression: normalizeServerExpression(s(c.definition)),
              values: [],
              implicit: undefined,
            });
          }
          const tableIndexes: Index[] = [];
          for (const [indexName, rows] of groupRows(
            forTable(indexes),
            "name",
          )) {
            if (
              rows.some(
                (r) =>
                  Number(r.type) !== 2 ||
                  r.is_disabled ||
                  r.is_descending_key ||
                  r.is_included_column,
              )
            )
              throw new Error(
                `Index ${indexName} uses unsupported clustering, descending order, INCLUDE or disabled attributes`,
              );
            tableIndexes.push({
              name: indexName,
              columns: rows.map((r) => s(r.column_name)),
              unique: Boolean(rows[0]!.is_unique),
              predicate:
                rows[0]!.filter_definition == null
                  ? undefined
                  : s(rows[0]!.filter_definition),
            });
          }
          return {
            name,
            columns: forTable(columns).map(column),
            constraints,
            indexes: tableIndexes,
          };
        }),
      };
    } catch (e) {
      throw new Error(`Failed to introspect SQL Server schema: ${(e as Error).message}`);
    }
  }
}
function column(row: Row): Column {
  if (
    row.is_computed ||
    row.is_sparse ||
    row.is_hidden ||
    Number(row.generated_always_type) !== 0 ||
    row.is_user_defined
  )
    throw new Error(
      `Column ${s(row.name)} uses an unsupported generated, sparse, hidden or user-defined type`,
    );
  let type = s(row.type_name);
  if (
    ["nvarchar", "varchar", "varbinary", "char", "nchar", "binary"].includes(
      type,
    )
  ) {
    const length = Number(row.max_length);
    type += `(${length === -1 ? "max" : type.startsWith("n") ? length / 2 : length})`;
  } else if (["decimal", "numeric"].includes(type))
    type += `(${s(row.precision)},${s(row.scale)})`;
  else if (["datetime2", "datetimeoffset", "time"].includes(type))
    type += `(${s(row.scale)})`;
  if (["timestamp", "rowversion"].includes(type))
    throw new Error(`Column ${s(row.name)} uses rowversion, which is not supported`);
  return {
    name: s(row.name),
    type: normalizeServerType(type, "mssql"),
    nullable: Boolean(row.is_nullable),
    length: undefined,
    default: row.default_value == null ? undefined : s(row.default_value),
    defaultConstraint:
      row.default_name == null ? undefined : s(row.default_name),
    collation: row.collation_name == null ? undefined : s(row.collation_name),
    autoIncrement: Boolean(row.is_identity),
    ordinal: Number(row.column_id),
    comment: undefined,
  };
}
