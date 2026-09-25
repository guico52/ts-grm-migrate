import { constraintName, type DdlContext, type DdlGenerator } from "../ddl.js";
import type { Diff, AlterTable } from "../diff/types.js";
import type {
  Column,
  Constraint,
  Index,
  Schema,
  Table,
} from "../schema/model.js";
import { ServerSql, type ServerDialect } from "./sql.js";

/** Dependency ordering shared by SQL Server and Oracle; syntax stays dialect-specific. */
export class ServerDdlGenerator implements DdlGenerator {
  readonly sql: ServerSql;
  constructor(
    readonly dialect: ServerDialect,
    schema: string,
  ) {
    this.sql = new ServerSql(dialect, schema);
  }

  statements(diff: Diff, context?: DdlContext): ReadonlyArray<string> {
    const dropFk = new Map<string, string>(),
      dropKeys = new Map<string, string>();
    const body: string[] = [],
      addKeys = new Map<string, string>(),
      addFk = new Map<string, string>();
    const q = (name: string): string => this.sql.identifier(name);
    const table = (name: string): string => this.sql.table(name);
    const dropping = new Set(
      diff.changes.filter((c) => c.kind === "DROP_TABLE").map((c) => c.table),
    );
    const altered = new Map(
      diff.changes
        .filter((c): c is AlterTable => c.kind === "ALTER_TABLE")
        .map((c) => [c.table, c]),
    );
    const columnChanged = (name: string): boolean =>
      altered.get(name)?.columns.some((c) => c.kind !== "ADD_COLUMN") ?? false;
    const keyChanged = (name: string): boolean =>
      altered
        .get(name)
        ?.constraints.some((c) => c.kind === "DROP_CONSTRAINT") ?? false;
    const removeConstraint = (name: string, c: Constraint): void => {
      if (!c.name) throw new Error(`Cannot drop constraint on ${name} without its physical name`);
      (c.kind === "FOREIGN_KEY" ? dropFk : dropKeys).set(
        `${name}\0${c.name}`,
        `alter table ${table(name)} drop constraint ${q(c.name)}`,
      );
    };
    const addConstraint = (name: string, c: Constraint, i: number): void => {
      const constraint = this.constraint(name, c, i);
      (c.kind === "FOREIGN_KEY" ? addFk : addKeys).set(
        `${name}\0${constraint}`,
        `alter table ${table(name)} add ${constraint}`,
      );
    };
    const removeIndex = (name: string, index: Index): void => {
      dropKeys.set(
        `${name}\0index:${index.name}`,
        this.dialect === "mssql"
          ? `drop index ${q(index.name)} on ${table(name)}`
          : `drop index ${table(index.name)}`,
      );
    };
    const addIndex = (name: string, index: Index): void => {
      addKeys.set(`${name}\0index:${index.name}`, this.index(name, index));
    };

    // The same before/after snapshot drives all dependency decisions, including incoming FKs.
    if (context)
      for (const before of context.from.tables) {
        const after = context.to.tables.find((t) => t.name === before.name);
        for (const c of before.constraints) {
          const affected =
            c.kind === "FOREIGN_KEY"
              ? dropping.has(before.name) ||
                columnChanged(before.name) ||
                columnChanged(c.referencedTable) ||
                keyChanged(c.referencedTable)
              : columnChanged(before.name);
          if (
            !affected ||
            (dropping.has(before.name) && c.kind !== "FOREIGN_KEY")
          )
            continue;
          removeConstraint(before.name, c);
          if (after)
            after.constraints.forEach((next, i) => {
              if (
                next.kind === c.kind &&
                (next.kind !== "FOREIGN_KEY" ||
                  (c.kind === "FOREIGN_KEY" &&
                    next.columns.join("\0") === c.columns.join("\0")))
              ) {
                addConstraint(before.name, next, i + 1);
              }
            });
        }
        if (columnChanged(before.name)) {
          for (const index of before.indexes) removeIndex(before.name, index);
          for (const index of after?.indexes ?? [])
            addIndex(before.name, index);
        }
      }

    for (const change of diff.changes) {
      if (change.kind === "CREATE_TABLE") {
        body.push(this.createTable(change.table));
        change.table.constraints.forEach((c, i) => {
          if (c.kind === "FOREIGN_KEY")
            addConstraint(change.table.name, c, i + 1);
        });
        for (const index of change.table.indexes)
          addIndex(change.table.name, index);
        continue;
      }
      if (change.kind === "DROP_TABLE") {
        for (const name of change.foreignKeyNames)
          dropFk.set(
            `${change.table}\0${name}`,
            `alter table ${table(change.table)} drop constraint ${q(name)}`,
          );
        body.push(`drop table ${table(change.table)}`);
        continue;
      }
      const before = context?.from.tables.find((t) => t.name === change.table);
      const after = context?.to.tables.find((t) => t.name === change.table);
      for (const c of change.constraints) {
        if (c.kind === "DROP_CONSTRAINT")
          removeConstraint(change.table, c.constraint);
        else
          addConstraint(
            change.table,
            c.constraint,
            (after?.constraints.indexOf(c.constraint) ??
              change.constraints.indexOf(c)) + 1,
          );
      }
      for (const idx of change.indexes) {
        if (idx.kind === "DROP_INDEX") removeIndex(change.table, idx.index);
        else addIndex(change.table, idx.index);
      }
      for (const col of change.columns) {
        const target = table(change.table);
        if (col.kind === "ADD_COLUMN") {
          body.push(
            `alter table ${target} add ${this.dialect === "oracle" ? `(${this.column(col.column)})` : this.column(col.column)}`,
          );
          continue;
        }
        const old = before?.columns.find((c) => c.name === col.column);
        if (!old)
          throw new Error(
            `Altering ${this.dialect} column ${change.table}.${col.column} requires its original definition in DdlContext`,
          );
        if (
          this.dialect === "mssql" &&
          old.defaultConstraint &&
          (col.kind === "DROP_COLUMN" ||
            col.default !== undefined ||
            col.type !== undefined)
        ) {
          dropKeys.set(
            `${change.table}\0default:${old.name}`,
            `alter table ${target} drop constraint ${q(old.defaultConstraint)}`,
          );
        }
        if (col.kind === "DROP_COLUMN") {
          body.push(`alter table ${target} drop column ${q(col.column)}`);
          continue;
        }
        if (
          col.autoIncrement !== undefined &&
          col.autoIncrement !== old.autoIncrement
        )
          throw new Error("Changing the identity strategy requires a manual migration");
        if (this.dialect === "mssql") {
          if (col.type !== undefined || col.nullable !== undefined)
            body.push(
              `alter table ${target} alter column ${q(col.column)} ${col.type ?? old.type}${/^(n?varchar|n?char|n?text)\b/i.test(col.type ?? old.type) && old.collation ? ` collate ${collationName(old.collation)}` : ""} ${(col.nullable ?? old.nullable) ? "null" : "not null"}`,
            );
          const defaultValue =
            col.default === undefined ? old.default : col.default || undefined;
          if (
            defaultValue !== undefined &&
            (col.default !== undefined || col.type !== undefined)
          ) {
            body.push(
              `alter table ${target} add default ${defaultValue} for ${q(col.column)}`,
            );
          }
        } else {
          const parts = [q(col.column)];
          if (col.type !== undefined) parts.push(col.type);
          if (col.default !== undefined)
            parts.push(`default ${col.default || "null"}`);
          if (col.nullable !== undefined)
            parts.push(col.nullable ? "null" : "not null");
          if (parts.length > 1)
            body.push(`alter table ${target} modify (${parts.join(" ")})`);
        }
      }
    }
    return [
      ...dropFk.values(),
      ...dropKeys.values(),
      ...body,
      ...addKeys.values(),
      ...addFk.values(),
    ];
  }

  createStatements(schema: Schema): ReadonlyArray<string> {
    return this.statements({
      changes: schema.tables.map((table) => ({ kind: "CREATE_TABLE", table })),
      destructive: [],
    });
  }
  private column(c: Column): string {
    const identity = c.autoIncrement
      ? this.dialect === "mssql"
        ? " identity(1,1)"
        : " generated by default as identity"
      : "";
    return `${this.sql.identifier(c.name)} ${c.type}${identity}${c.default !== undefined && c.default !== "" ? ` default ${c.default}` : ""}${c.nullable ? " null" : " not null"}`;
  }
  private createTable(table: Table): string {
    const parts = table.columns.map((c) => this.column(c));
    table.constraints.forEach((c, i) => {
      if (c.kind !== "FOREIGN_KEY")
        parts.push(this.constraint(table.name, c, i + 1));
    });
    return `create table ${this.sql.table(table.name)} (\n  ${parts.join(",\n  ")}\n)`;
  }
  private constraint(table: string, c: Constraint, sequence: number): string {
    const q = (v: string): string => this.sql.identifier(v);
    const prefix = `constraint ${q(c.name ?? this.sql.name(constraintName(table, c, sequence)))}`;
    switch (c.kind) {
      case "PRIMARY_KEY":
        return `${prefix} primary key (${c.columns.map(q).join(", ")})`;
      case "UNIQUE":
        return `${prefix} unique (${c.columns.map(q).join(", ")})`;
      case "CHECK":
        return `${prefix} check (${c.expression})`;
      case "FOREIGN_KEY": {
        if (c.deferrable) throw new Error("Deferrable foreign keys are not supported by this migration dialect");
        if (this.dialect === "oracle" && c.onDelete === "SET_DEFAULT")
          throw new Error("Oracle does not support ON DELETE SET DEFAULT");
        const action = ["NO_ACTION", "RESTRICT"].includes(c.onDelete)
          ? ""
          : ` on delete ${c.onDelete.replaceAll("_", " ")}`;
        return `${prefix} foreign key (${c.columns.map(q).join(", ")}) references ${this.sql.table(c.referencedTable)} (${c.referencedColumns.map(q).join(", ")})${action}`;
      }
    }
  }
  private index(table: string, idx: Index): string {
    if (idx.predicate && this.dialect === "oracle")
      throw new Error("Oracle does not support partial indexes");
    return `create ${idx.unique ? "unique " : ""}index ${this.dialect === "mssql" ? this.sql.identifier(idx.name) : this.sql.table(idx.name)} on ${this.sql.table(table)} (${idx.columns.map((c) => this.sql.identifier(c)).join(", ")})${idx.predicate ? ` where ${idx.predicate}` : ""}`;
  }
}

function collationName(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value))
    throw new Error("Unsupported SQL Server collation name");
  return value;
}
