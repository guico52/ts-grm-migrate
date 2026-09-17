/**
 * Postgres DDL 生成器。
 *
 * - 列/约束/索引级变更自建（ts-grm 无单条变更 API）；
 * - CREATE_TABLE **自建**（带引号标识符）：ts-grm 原生 toCreationStatements 的
 *   表名不带引号（`create table AUTHOR`），PG 会把未加引号的标识符折叠为小写
 *   （`author`），与目标态/快照的表名（`AUTHOR`）不一致 → introspection 后的
 *   diff 会永久误判。原生建表复用只保留给 SQLite（无大小写折叠问题，
 *   见 src/ddl/sqlite.ts）。
 * - 标识符一律加引号（表/列名来自数据库实际名字，防保留字与大小写折叠）。
 */
import type { AlterTable, ColumnChange, ConstraintChange, IndexChange } from "../diff/types.js";
import type { Diff } from "../diff/types.js";
import type { Schema, Table as SchemaTable } from "../schema/model.js";
import {
  columnSql,
  constraintName,
  constraintSql,
  createTableSql,
  quoteIdentifier,
} from "../ddl.js";
import type { DdlGenerator } from "../ddl.js";
import type { Dialect } from "../introspector.js";

const q = quoteIdentifier;

export class PostgresDdlGenerator implements DdlGenerator {
  readonly dialect: Dialect = "postgres";

  statements(diff: Diff): ReadonlyArray<string> {
    const sql: Array<string> = [];
    for (const change of diff.changes) {
      switch (change.kind) {
        case "CREATE_TABLE":
          sql.push(createTableSql(change.table));
          break;
        case "DROP_TABLE":
          sql.push(`drop table ${q(change.table)}`);
          break;
        case "ALTER_TABLE":
          sql.push(...this._alterTable(change));
          break;
      }
    }
    return sql;
  }

  createStatements(schema: Schema): ReadonlyArray<string> {
    return schema.tables.map(createTableSql);
  }

  private _alterTable(change: AlterTable): ReadonlyArray<string> {
    const sql: Array<string> = [];
    const table = q(change.table);
    let seq = 0;
    for (const col of change.columns) {
      sql.push(...this._columnChange(table, col));
    }
    for (const con of change.constraints) {
      sql.push(...this._constraintChange(table, change.table, con, ++seq));
    }
    for (const idx of change.indexes) {
      sql.push(...this._indexChange(table, idx));
    }
    return sql;
  }

  private _columnChange(table: string, col: ColumnChange): ReadonlyArray<string> {
    switch (col.kind) {
      case "ADD_COLUMN":
        return [`alter table ${table} add column ${columnSql(col.column)}`];
      case "DROP_COLUMN":
        return [`alter table ${table} drop column ${q(col.column)}`];
      case "ALTER_COLUMN": {
        const sql: Array<string> = [];
        const column = q(col.column);
        if (col.type != null) {
          // 类型转换：PG 对 text→int 等需要 USING；diff 只记录「类型变了」，USING 暂由迁移 SQL 手写补充
          sql.push(`alter table ${table} alter column ${column} type ${col.type}`);
        }
        if (col.nullable != null) {
          sql.push(
            `alter table ${table} alter column ${column} ${col.nullable ? "drop not null" : "set not null"}`,
          );
        }
        if (col.default !== undefined) {
          sql.push(
            col.default === ""
              ? `alter table ${table} alter column ${column} drop default`
              : `alter table ${table} alter column ${column} set default ${col.default}`,
          );
        }
        return sql;
      }
    }
  }

  private _constraintChange(
    table: string,
    tableName: string,
    con: ConstraintChange,
    seq: number,
  ): ReadonlyArray<string> {
    switch (con.kind) {
      case "ADD_CONSTRAINT": {
        const name = constraintName(tableName, con.constraint, seq);
        return [`alter table ${table} add ${constraintSql(con.constraint, name)}`];
      }
      case "DROP_CONSTRAINT": {
        // 现状约束有名字（introspection 填写）；缺失时按目标态规则生成（可能不匹配，注释警告）
        const name = con.constraint.name ?? constraintName(tableName, con.constraint, seq);
        const sql = `alter table ${table} drop constraint ${q(name)}`;
        return con.constraint.name == null ? [`-- WARN: 约束名缺失，按生成规则推断，请核对\n${sql}`] : [sql];
      }
    }
  }

  private _indexChange(table: string, idx: IndexChange): ReadonlyArray<string> {
    switch (idx.kind) {
      case "ADD_INDEX":
        return [
          `create ${idx.index.unique ? "unique " : ""}index ${q(idx.index.name)} on ${table} (${idx.index.columns.map(q).join(", ")})`,
        ];
      case "DROP_INDEX":
        return [`drop index ${q(idx.index.name)}`];
    }
  }
}
