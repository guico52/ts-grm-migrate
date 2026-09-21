import type { Introspector, SqlQueryable } from "../introspector.js";
import type { Column, Constraint, Index, Schema } from "../schema/model.js";
import {
  groupRows,
  stringValue as s,
  normalizeServerExpression,
  type CatalogRow as Row,
} from "../server/catalog.js";
import { normalizeServerType } from "../server/sql.js";

/** @see https://docs.oracle.com/en/database/oracle/oracle-database/23/refrn/ALL_TAB_COLUMNS.html */
export class OracleIntrospector implements Introspector {
  readonly dialect = "oracle" as const;
  constructor(
    private readonly options: { query: SqlQueryable; schema: string },
  ) {}
  async introspect(): Promise<Schema> {
    const query = async (sql: string): Promise<ReadonlyArray<Row>> =>
      (await this.options.query.query(sql, [this.options.schema])).rows;
    try {
      const tables = await query(
        "select table_name, temporary, nested, secondary, iot_type from all_tables where owner=:1 and table_name not like 'BIN$%' order by table_name",
      );
      const columns = await query(
        "select table_name,column_name,data_type,data_length,data_precision,data_scale,char_length,char_used,nullable,data_default,identity_column,virtual_column,hidden_column,column_id from all_tab_cols where owner=:1 and table_name not like 'BIN$%' order by table_name,column_id",
      );
      const constraints =
        await query(`select c.table_name,c.constraint_name,c.constraint_type,c.search_condition_vc,c.status,c.validated,c.deferrable,c.delete_rule,c.generated,c.index_name,
        cc.column_name,cc.position,rc.owner as ref_owner,rc.table_name as ref_table,rcc.column_name as ref_column
        from all_constraints c left join all_cons_columns cc on cc.owner=c.owner and cc.constraint_name=c.constraint_name
        left join all_constraints rc on rc.owner=c.r_owner and rc.constraint_name=c.r_constraint_name
        left join all_cons_columns rcc on rcc.owner=rc.owner and rcc.constraint_name=rc.constraint_name and rcc.position=cc.position
        where c.owner=:1 order by c.table_name,c.constraint_name,cc.position`);
      const indexes =
        await query(`select i.table_name,i.index_name,i.uniqueness,i.index_type,i.status,c.column_name,c.column_position,c.descend
        from all_indexes i join all_ind_columns c on c.index_owner=i.owner and c.index_name=i.index_name
        where i.table_owner=:1 order by i.table_name,i.index_name,c.column_position`);
      return {
        tables: tables.map((table) => {
          const name = s(table.TABLE_NAME);
          if (
            table.TEMPORARY !== "N" ||
            table.NESTED !== "NO" ||
            table.SECONDARY !== "N" ||
            table.IOT_TYPE != null
          )
            throw new Error(
              `Oracle 表 ${name} 使用临时、嵌套或组织索引结构，尚不支持`,
            );
          const forTable = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
            rows.filter((r) => r.TABLE_NAME === name);
          const tableColumns = forTable(columns).map(column);
          const tableConstraints: Constraint[] = [];
          const constraintIndexes = new Set<string>();
          for (const [constraintName, rows] of groupRows(
            forTable(constraints),
            "CONSTRAINT_NAME",
          )) {
            const c = rows[0]!;
            if (
              c.STATUS !== "ENABLED" ||
              c.VALIDATED !== "VALIDATED" ||
              c.DEFERRABLE !== "NOT DEFERRABLE"
            )
              throw new Error(
                `约束 ${constraintName} 未验证/启用或使用延迟检查，尚不支持`,
              );
            const names = rows.map((r) => s(r.COLUMN_NAME));
            switch (c.CONSTRAINT_TYPE) {
              case "P":
              case "U":
                constraintIndexes.add(s(c.INDEX_NAME));
                tableConstraints.push({
                  kind: c.CONSTRAINT_TYPE === "P" ? "PRIMARY_KEY" : "UNIQUE",
                  name: constraintName,
                  columns: names,
                  implicit: undefined,
                });
                break;
              case "R": {
                if (c.REF_OWNER !== this.options.schema)
                  throw new Error(`外键 ${constraintName} 跨 schema，尚不支持`);
                const onDelete =
                  c.DELETE_RULE === "CASCADE"
                    ? "CASCADE"
                    : c.DELETE_RULE === "SET NULL"
                      ? "SET_NULL"
                      : "NO_ACTION";
                tableConstraints.push({
                  kind: "FOREIGN_KEY",
                  name: constraintName,
                  columns: names,
                  referencedTable: s(c.REF_TABLE),
                  referencedColumns: rows.map((r) => s(r.REF_COLUMN)),
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
                break;
              }
              case "C": {
                const expression = s(c.SEARCH_CONDITION_VC);
                // Oracle represents NOT NULL as a CHECK; nullability already expresses it.
                if (
                  /^"(?:""|[^"])+" IS NOT NULL$/i.test(expression.trim()) &&
                  names.length === 1 &&
                  tableColumns.some(
                    (col) => col.name === names[0] && !col.nullable,
                  )
                )
                  break;
                if (expression.length >= 4000)
                  throw new Error(
                    `CHECK ${constraintName} 超出 catalog 表达式长度，不能安全读取`,
                  );
                tableConstraints.push({
                  kind: "CHECK",
                  name: constraintName,
                  expression,
                  comparisonExpression: normalizeServerExpression(expression),
                  values: [],
                  implicit: undefined,
                });
                break;
              }
              default:
                throw new Error(
                  `不支持的 Oracle 约束类型 ${s(c.CONSTRAINT_TYPE)}`,
                );
            }
          }
          const tableIndexes: Index[] = [];
          for (const [indexName, rows] of groupRows(
            forTable(indexes),
            "INDEX_NAME",
          )) {
            if (constraintIndexes.has(indexName)) continue;
            // LOB storage indexes are internal implementation details.
            if (rows[0]!.INDEX_TYPE === "LOB") continue;
            if (
              rows.some(
                (r) =>
                  r.INDEX_TYPE !== "NORMAL" ||
                  r.DESCEND !== "ASC" ||
                  r.STATUS !== "VALID",
              )
            )
              throw new Error(
                `索引 ${indexName} 使用表达式、降序或特殊结构，尚不支持`,
              );
            tableIndexes.push({
              name: indexName,
              columns: rows.map((r) => s(r.COLUMN_NAME)),
              unique: rows[0]!.UNIQUENESS === "UNIQUE",
              predicate: undefined,
            });
          }
          return {
            name,
            columns: tableColumns,
            constraints: tableConstraints,
            indexes: tableIndexes,
          };
        }),
      };
    } catch (e) {
      throw new Error(`读取 Oracle 结构失败：${(e as Error).message}`);
    }
  }
}
function column(row: Row): Column {
  if (row.VIRTUAL_COLUMN === "YES" || row.HIDDEN_COLUMN === "YES")
    throw new Error(`列 ${s(row.COLUMN_NAME)} 为虚拟/隐藏列，尚不支持`);
  let type = s(row.DATA_TYPE).toLowerCase();
  if (["varchar2", "char"].includes(type))
    type +=
      row.CHAR_USED === "C"
        ? `(${s(row.CHAR_LENGTH)} char)`
        : `(${s(row.DATA_LENGTH)})`;
  else if (["nvarchar2", "nchar"].includes(type))
    type += `(${s(row.CHAR_LENGTH)})`;
  else if (type === "raw") type += `(${s(row.DATA_LENGTH)})`;
  else if (type === "number" && row.DATA_PRECISION != null)
    type += `(${s(row.DATA_PRECISION)},${s(row.DATA_SCALE ?? 0)})`;
  else if (type === "float" && row.DATA_PRECISION != null)
    type += `(${s(row.DATA_PRECISION)})`;
  const identity = row.IDENTITY_COLUMN === "YES";
  const defaultValue =
    row.DATA_DEFAULT == null ? undefined : s(row.DATA_DEFAULT).trim();
  return {
    name: s(row.COLUMN_NAME),
    type: normalizeServerType(type, "oracle"),
    nullable: row.NULLABLE === "Y",
    length: undefined,
    default:
      identity || defaultValue?.toLowerCase() === "null"
        ? undefined
        : defaultValue,
    autoIncrement: identity,
    ordinal: Number(row.COLUMN_ID),
    comment: undefined,
  };
}
