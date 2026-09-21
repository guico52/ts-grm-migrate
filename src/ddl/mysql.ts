import type { DdlContext, DdlGenerator } from "../ddl.js";
import { constraintName } from "../ddl.js";
import type { Diff } from "../diff/types.js";
import type { Column, Constraint, ForeignKeyConstraint, Index, Schema, Table } from "../schema/model.js";
import { mysqlName, quoteMysqlIdentifier as q, quoteMysqlLiteral as literal } from "../mysql/sql.js";

/**
 * Phase ordering: drop dependent FKs/indexes/constraints, alter columns, add keys, add FKs.
 * CREATE foreign keys are deferred so table order and cyclic references are harmless.
 * @see https://github.com/prisma/prisma-engines/blob/main/schema-engine/connectors/sql-schema-connector/src/flavour/mysql/renderer.rs
 */
export class MysqlDdlGenerator implements DdlGenerator {
  readonly dialect = "mysql" as const;

  statements(diff: Diff, context?: DdlContext): ReadonlyArray<string> {
    const detach: string[] = [], dropKeys: string[] = [], body: string[] = [], addKeys: string[] = [], attach: string[] = [];
    const droppedForeignKeys = new Set<string>();
    const addedForeignKeys = new Set<string>();
    const dropFk = (table: string, fk: ForeignKeyConstraint): void => {
      if (!fk.name) throw new Error(`删除外键 ${table} 时缺少实际约束名`);
      const key = `${table}\0${fk.name}`;
      if (droppedForeignKeys.has(key)) return;
      droppedForeignKeys.add(key);
      detach.push(`alter table ${q(table)} drop foreign key ${q(fk.name)}`);
    };
    const addFk = (table: string, fk: ForeignKeyConstraint, seq: number): void => {
      const key = `${table}\0${fk.columns.join("\0")}`;
      if (addedForeignKeys.has(key)) return;
      addedForeignKeys.add(key);
      attach.push(`alter table ${q(table)} add ${constraintSql(table, fk, seq)}`);
    };
    const needsDetach = (table: string, columns: ReadonlyArray<string>): boolean => diff.changes.some((change) =>
      change.kind === "ALTER_TABLE" && change.table === table && (
        change.columns.some((c) => c.kind !== "ADD_COLUMN" && columns.includes(c.column) &&
          (c.kind === "DROP_COLUMN" || c.type !== undefined || c.nullable !== undefined)) ||
        change.constraints.some((c) => c.kind === "DROP_CONSTRAINT" &&
          (c.constraint.kind === "PRIMARY_KEY" || c.constraint.kind === "UNIQUE")) ||
        change.indexes.some((i) => i.kind === "DROP_INDEX")
      ));
    if (context) {
      for (const table of context.from.tables) {
        for (const fk of table.constraints) {
          if (fk.kind !== "FOREIGN_KEY") continue;
          if (!needsDetach(table.name, fk.columns) && !needsDetach(fk.referencedTable, fk.referencedColumns)) continue;
          dropFk(table.name, fk);
          const target = context.to.tables.find((t) => t.name === table.name);
          const next = target?.constraints.find((c): c is ForeignKeyConstraint => c.kind === "FOREIGN_KEY" &&
            c.columns.join("\0") === fk.columns.join("\0") && c.referencedTable === fk.referencedTable);
          if (next) addFk(table.name, next, target!.constraints.indexOf(next) + 1);
        }
      }
    }

    for (const change of diff.changes) {
      if (change.kind === "CREATE_TABLE") {
        body.push(createTable(change.table));
        change.table.constraints.forEach((c, i) => { if (c.kind === "FOREIGN_KEY") addFk(change.table.name, c, i + 1); });
        continue;
      }
      if (change.kind === "DROP_TABLE") {
        for (const name of change.foreignKeyNames) {
          const key = `${change.table}\0${name}`;
          if (!droppedForeignKeys.has(key)) {
            droppedForeignKeys.add(key);
            detach.push(`alter table ${q(change.table)} drop foreign key ${q(name)}`);
          }
        }
        body.push(`drop table ${q(change.table)}`);
        continue;
      }
      const table = q(change.table);
      const before = context?.from.tables.find((t) => t.name === change.table);
      for (const con of change.constraints) {
        if (con.kind === "DROP_CONSTRAINT") {
          const c = con.constraint;
          if (c.kind === "FOREIGN_KEY") { dropFk(change.table, c); continue; }
          if (c.kind !== "PRIMARY_KEY" && !c.name) throw new Error(`删除约束 ${change.table} 时缺少实际约束名`);
          dropKeys.push(`alter table ${table} drop ${c.kind === "PRIMARY_KEY" ? "primary key" : c.kind === "UNIQUE" ? `index ${q(c.name!)}` : `check ${q(c.name!)}`}`);
        } else {
          const seq = context?.to.tables.find((t) => t.name === change.table)?.constraints.indexOf(con.constraint) ?? change.constraints.indexOf(con);
          if (con.constraint.kind === "FOREIGN_KEY") addFk(change.table, con.constraint, seq + 1);
          else addKeys.push(`alter table ${table} add ${constraintSql(change.table, con.constraint, seq + 1)}`);
        }
      }
      for (const idx of change.indexes) {
        if (idx.kind === "DROP_INDEX") dropKeys.push(`drop index ${q(idx.index.name)} on ${table}`);
        else addKeys.push(`create ${indexSql(idx.index)} on ${table} (${idx.index.columns.map(q).join(", ")})`);
      }
      for (const col of change.columns) {
        if (col.kind === "ADD_COLUMN") body.push(`alter table ${table} add column ${columnSql(col.column)}`);
        else if (col.kind === "DROP_COLUMN") body.push(`alter table ${table} drop column ${q(col.column)}`);
        else {
          const previous = before?.columns.find((c) => c.name === col.column);
          if (!previous) throw new Error(`MySQL 修改 ${change.table}.${col.column} 需要 DdlContext 中的原始列定义`);
          const next: Column = {
            ...previous,
            type: col.type ?? previous.type,
            nullable: col.nullable ?? previous.nullable,
            default: col.default === undefined ? previous.default : col.default === "" ? undefined : col.default,
            autoIncrement: col.autoIncrement ?? previous.autoIncrement,
          };
          body.push(`alter table ${table} modify column ${columnSql(next)}`);
        }
      }
    }
    return [...detach, ...dropKeys, ...body, ...addKeys, ...attach];
  }

  createStatements(schema: Schema): ReadonlyArray<string> {
    return this.statements({ changes: schema.tables.map((table) => ({ kind: "CREATE_TABLE", table })), destructive: [] });
  }
}

function columnSql(column: Column): string {
  let sql = `${q(column.name)} ${column.type}`;
  if (column.mysql?.charset) sql += ` character set ${q(column.mysql.charset)}`;
  if (column.mysql?.collation) sql += ` collate ${q(column.mysql.collation)}`;
  sql += column.nullable ? " null" : " not null";
  if (column.default !== undefined && column.default !== "") sql += ` default ${column.default}`;
  if (column.mysql?.onUpdate) sql += ` on update ${column.mysql.onUpdate}`;
  if (column.autoIncrement) sql += " auto_increment";
  if (column.comment !== undefined) sql += ` comment ${literal(column.comment)}`;
  return sql;
}
function constraintSql(table: string, constraint: Constraint, seq: number): string {
  const name = mysqlName(constraintName(table, constraint, seq));
  const prefix = `constraint ${q(name)}`;
  switch (constraint.kind) {
    case "PRIMARY_KEY": return `primary key (${constraint.columns.map(q).join(", ")})`;
    case "UNIQUE": return `${prefix} unique (${constraint.columns.map(q).join(", ")})`;
    case "CHECK": return `${prefix} check (${constraint.expression})`;
    case "FOREIGN_KEY": {
      if (constraint.deferrable || constraint.onDelete === "SET_DEFAULT") throw new Error("MySQL 不支持 DEFERRABLE 或 ON DELETE SET DEFAULT");
      const action = constraint.onDelete.replaceAll("_", " ");
      return `${prefix} foreign key (${constraint.columns.map(q).join(", ")}) references ${q(constraint.referencedTable)} (${constraint.referencedColumns.map(q).join(", ")}) on delete ${action}`;
    }
  }
}
function indexSql(index: Index): string {
  if (index.predicate != null) throw new Error(`MySQL 不支持部分索引 ${index.name}`);
  return `${index.unique ? "unique " : ""}index ${q(index.name)}`;
}
function createTable(table: Table): string {
  const parts = table.columns.map(columnSql);
  table.constraints.forEach((c, i) => { if (c.kind !== "FOREIGN_KEY") parts.push(constraintSql(table.name, c, i + 1)); });
  for (const index of table.indexes) parts.push(`${indexSql(index)} (${index.columns.map(q).join(", ")})`);
  return `create table ${q(table.name)} (\n  ${parts.join(",\n  ")}\n) engine=InnoDB`;
}
