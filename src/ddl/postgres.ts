/** PostgreSQL DDL uses physical quoted names and defers foreign keys until all keys exist.
 * Dependency removal precedes column/table changes; keys and indexes precede foreign keys.
 */
import type { ColumnChange, ConstraintChange, IndexChange } from '../diff/types.js';
import type { Diff } from '../diff/types.js';
import type { Schema } from '../schema/model.js';
import {
  columnSql,
  constraintName,
  constraintSql,
  createTableSql,
  quoteIdentifier,
} from '../ddl.js';
import type { DdlContext, DdlGenerator } from '../ddl.js';
import type { Dialect } from '../introspector.js';

const q = quoteIdentifier;

export class PostgresDdlGenerator implements DdlGenerator {
  readonly dialect: Dialect = 'postgres';

  statements(diff: Diff, context?: DdlContext): ReadonlyArray<string> {
    const dropFks = new Map<string, string>();
    const dropKeys: string[] = [],
      dropIndexes: string[] = [],
      body: string[] = [],
      drops: string[] = [];
    const addKeys: string[] = [],
      addIndexes: string[] = [];
    const addFks = new Map<string, string>();
    const removeFk = (table: string, c: ConstraintChange['constraint'], seq: number): void => {
      dropFks.set(
        `${table}\0${c.name ?? c.kind + seq}`,
        this._constraintChange(
          q(table),
          table,
          { kind: 'DROP_CONSTRAINT', constraint: c },
          seq,
        )[0]!,
      );
    };
    const addFk = (table: string, c: ConstraintChange['constraint'], seq: number): void => {
      addFks.set(
        `${table}\0${c.kind === 'FOREIGN_KEY' ? c.columns.join('\0') : seq}`,
        this._constraintChange(q(table), table, { kind: 'ADD_CONSTRAINT', constraint: c }, seq)[0]!,
      );
    };
    // Unchanged incoming FKs also depend on keys being replaced and columns changing type.
    // @see https://github.com/prisma/prisma-engines/tree/main/schema-engine/connectors/sql-schema-connector/src/sql_schema_differ
    const affected = (table: string, columns: ReadonlyArray<string>): boolean =>
      diff.changes.some(
        (change) =>
          change.kind === 'ALTER_TABLE' &&
          change.table === table &&
          (change.columns.some(
            (c) =>
              c.kind !== 'ADD_COLUMN' &&
              columns.includes(c.column) &&
              (c.kind === 'DROP_COLUMN' || c.type !== undefined),
          ) ||
            change.constraints.some(
              (c) =>
                c.kind === 'DROP_CONSTRAINT' &&
                (c.constraint.kind === 'PRIMARY_KEY' || c.constraint.kind === 'UNIQUE'),
            )),
      );
    if (context)
      for (const table of context.from.tables) {
        for (const c of table.constraints) {
          if (
            c.kind !== 'FOREIGN_KEY' ||
            (!affected(table.name, c.columns) && !affected(c.referencedTable, c.referencedColumns))
          )
            continue;
          removeFk(table.name, c, table.constraints.indexOf(c) + 1);
          const target = context.to.tables.find((t) => t.name === table.name);
          const next = target?.constraints.find(
            (n) => n.kind === 'FOREIGN_KEY' && n.columns.join('\0') === c.columns.join('\0'),
          );
          if (next) addFk(table.name, next, target!.constraints.indexOf(next) + 1);
        }
      }
    for (const change of diff.changes) {
      if (change.kind === 'CREATE_TABLE') {
        body.push(
          createTableSql(
            {
              ...change.table,
              constraints: change.table.constraints.filter((c) => c.kind !== 'FOREIGN_KEY'),
              indexes: [],
            },
            'postgres',
          ),
        );
        change.table.constraints.forEach((c, i) => {
          if (c.kind === 'FOREIGN_KEY') addFk(change.table.name, c, i + 1);
        });
        for (const index of change.table.indexes)
          addIndexes.push(...this._indexChange(q(change.table.name), { kind: 'ADD_INDEX', index }));
      } else if (change.kind === 'DROP_TABLE') {
        for (const name of change.foreignKeyNames)
          dropFks.set(
            `${change.table}\0${name}`,
            `alter table ${q(change.table)} drop constraint ${q(name)}`,
          );
        drops.push(`drop table ${q(change.table)}`);
      } else {
        for (const col of change.columns) body.push(...this._columnChange(q(change.table), col));
        change.constraints.forEach((con, i) => {
          const target = context?.to.tables.find((t) => t.name === change.table);
          const targetIndex = target?.constraints.indexOf(con.constraint) ?? -1;
          const seq = targetIndex >= 0 ? targetIndex + 1 : i + 1;
          if (con.constraint.kind === 'FOREIGN_KEY') {
            if (con.kind === 'DROP_CONSTRAINT') removeFk(change.table, con.constraint, seq);
            else addFk(change.table, con.constraint, seq);
          } else {
            (con.kind === 'DROP_CONSTRAINT' ? dropKeys : addKeys).push(
              ...this._constraintChange(q(change.table), change.table, con, seq),
            );
          }
        });
        for (const idx of change.indexes)
          (idx.kind === 'DROP_INDEX' ? dropIndexes : addIndexes).push(
            ...this._indexChange(q(change.table), idx),
          );
      }
    }
    return [
      ...dropFks.values(),
      ...dropKeys,
      ...dropIndexes,
      ...body,
      ...drops,
      ...addKeys,
      ...addIndexes,
      ...addFks.values(),
    ];
  }

  createStatements(schema: Schema): ReadonlyArray<string> {
    return this.statements({
      changes: schema.tables.map((table) => ({ kind: 'CREATE_TABLE', table })),
      destructive: [],
    });
  }

  private _columnChange(table: string, col: ColumnChange): ReadonlyArray<string> {
    switch (col.kind) {
      case 'ADD_COLUMN':
        return [`alter table ${table} add column ${columnSql(col.column, 'postgres')}`];
      case 'DROP_COLUMN':
        return [`alter table ${table} drop column ${q(col.column)}`];
      case 'ALTER_COLUMN': {
        const sql: Array<string> = [];
        const column = q(col.column);
        // 已有列的自增开关无法在 PG 上安全生成：加 identity 要求列 NOT NULL、
        // 且可能需要对存量数据回填；删 identity 会连带删除序列。因此报错让人
        // 手写迁移，而不是生成有副作用的语句（同 server/ddl.ts 的既有取舍）。
        if (col.autoIncrement !== undefined) {
          throw new Error(
            `Changing the identity of existing column ${col.column} requires a manual migration ` +
              `(add or drop GENERATED ... AS IDENTITY by hand, then use tgm resolve --applied <id>).`,
          );
        }
        if (col.type != null) {
          // 类型转换：PG 对 text→int 等需要 USING；diff 只记录「类型变了」，USING 暂由迁移 SQL 手写补充
          sql.push(`alter table ${table} alter column ${column} type ${col.type}`);
        }
        if (col.nullable != null) {
          sql.push(
            `alter table ${table} alter column ${column} ${col.nullable ? 'drop not null' : 'set not null'}`,
          );
        }
        if (col.default !== undefined) {
          sql.push(
            col.default === ''
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
      case 'ADD_CONSTRAINT': {
        const name = constraintName(tableName, con.constraint, seq);
        return [`alter table ${table} add ${constraintSql(con.constraint, name)}`];
      }
      case 'DROP_CONSTRAINT': {
        // 现状约束有名字（introspection 填写）；缺失时按目标态规则生成（可能不匹配，注释警告）
        const name = con.constraint.name ?? constraintName(tableName, con.constraint, seq);
        const sql = `alter table ${table} drop constraint ${q(name)}`;
        return con.constraint.name == null
          ? [
              `-- WARN: Constraint name missing; inferred from naming rules. Verify before applying.\n${sql}`,
            ]
          : [sql];
      }
    }
  }

  private _indexChange(table: string, idx: IndexChange): ReadonlyArray<string> {
    switch (idx.kind) {
      case 'ADD_INDEX':
        return [
          `create ${idx.index.unique ? 'unique ' : ''}index ${q(idx.index.name)} on ${table} (${idx.index.columns.map(q).join(', ')})${idx.index.predicate ? ` where ${idx.index.predicate}` : ''}`,
        ];
      case 'DROP_INDEX':
        return [`drop index ${q(idx.index.name)}`];
    }
  }
}
