/**
 * SQLite DDL 生成器。
 *
 * SQLite 的 ALTER 能力极弱：只能 ADD COLUMN（且限制多），不能 drop column /
 * 改类型 / 改约束。因此：
 * - 纯 ADD_COLUMN → 原地 `alter table add column`；
 * - 其余列变更 / 任何约束变更 → **重建表路径**：
 *   `drop 旧表 + 原生建表（目标态 TableDef）+ 数据迁移 TODO`，
 *   建表复用 ts-grm `toCreationStatements`（与 ts-grm 建表语义零漂移）；
 * - 索引变更：SQLite 支持独立 create/drop index，不触发重建。
 *
 * 重建表需要目标表结构，因此依赖 DdlGeneratorOptions.tableDefs（生成期持有）；
 * 缺失时抛错提示（无法从 diff 反推完整目标结构）。
 */
import type { AlterTable, ColumnChange, ConstraintChange, IndexChange } from "../diff/types.js";
import type { Diff } from "../diff/types.js";
import type { Schema, Table as SchemaTable } from "../schema/model.js";
import type { SchemaDriver } from "../schema/adapter.js";
import type { TableDef } from "../vendor/ts-grm.js";
import { columnSql, createTableSql, quoteIdentifier } from "../ddl.js";
import type { DdlGenerator, DdlGeneratorOptions } from "../ddl.js";
import type { Dialect } from "../introspector.js";

const q = quoteIdentifier;

export class SqliteDdlGenerator implements DdlGenerator {
  readonly dialect: Dialect = "sqlite";

  constructor(private readonly _options: DdlGeneratorOptions = {}) {}

  statements(diff: Diff): ReadonlyArray<string> {
    const sql: Array<string> = [];
    for (const change of diff.changes) {
      switch (change.kind) {
        case "CREATE_TABLE":
          sql.push(...this._createTable(change.table));
          break;
        case "DROP_TABLE":
          // 不处理 change.foreignKeyNames：SQLite 没有 `alter table ... drop
          // constraint`，且它删表时不校验外键依赖，不存在 PG 那个问题。
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
    const sql: Array<string> = [];
    for (const table of schema.tables) {
      sql.push(...this._createTable(table));
    }
    return sql;
  }

  private _createTable(table: SchemaTable): ReadonlyArray<string> {
    const tableDef = this._options.tableDefs?.get(table.name);
    if (tableDef != null) {
      if (this._options.driver == null) {
        throw new Error(
          `Creating table ${table.name} requires a dialect driver in DdlGeneratorOptions.driver`,
        );
      }
      return tableDef.toCreationStatements(this._options.driver);
    }
    return [createTableSql(table)];
  }

  private _alterTable(change: AlterTable): ReadonlyArray<string> {
    // 索引变更：SQLite 独立支持，无需重建
    const sql: Array<string> = [...this._indexChanges(q(change.table), change.indexes)];

    const needRebuild =
      change.columns.some((c) => c.kind !== "ADD_COLUMN") || change.constraints.length > 0;
    if (needRebuild) {
      sql.push(...this._rebuildTable(change.table));
    } else {
      for (const col of change.columns) {
        if (col.kind === "ADD_COLUMN") {
          sql.push(...this._addColumn(q(change.table), col));
        }
      }
    }
    return sql;
  }

  /** 纯 ADD_COLUMN 原地执行（SQLite 对 not null / unique 有额外限制，注释提示） */
  private _addColumn(table: string, col: Extract<ColumnChange, { readonly kind: "ADD_COLUMN" }>): ReadonlyArray<string> {
    const column = col.column;
    const sql = `alter table ${table} add column ${columnSql(column)}`;
    return column.nullable
      ? [sql]
      : [
          sql,
          "-- Note: SQLite cannot add a NOT NULL column without a default; rebuild the table if this fails",
        ];
  }

  /**
   * 重建表路径：SQLite 无法原地 drop column / 改类型 / 改约束，官方做法是
   * 「建新表 → 搬数据 → 换名」。但正确的重建还要同时处理三件目前无法安全完成的事：
   *
   * 1. **外部外键要重定向**。引用该表的其他表，会因 `alter table rename` 被 SQLite
   *    一并改成指向临时表，换名后需要逐个改回；
   * 2. **索引与触发器会随旧表消失**，需按目标态重建 —— 而索引在模型侧无来源；
   * 3. **可搬迁的列是目标与现状的交集**，需要现状信息，而 DDL 生成器只有目标态。
   *
   * 在这三件事设计清楚之前，这里**显式报错**，而不是生成会丢数据的语句 ——
   * 后者只会在真实库里安静地把表清空。这是刻意的取舍，不是遗漏。
   */
  private _rebuildTable(tableName: string): ReadonlyArray<string> {
    throw new Error(
      `SQLite cannot alter the columns or constraints of table "${tableName}" in place; table rebuild is not implemented. ` +
        `A safe rebuild must preserve external foreign keys, indexes and data. ` +
        `Rebuild manually, then use tgm resolve --applied <id> to record the migration.`,
    );
  }

  private _indexChanges(table: string, indexes: ReadonlyArray<IndexChange>): ReadonlyArray<string> {
    const sql: Array<string> = [];
    for (const idx of indexes) {
      switch (idx.kind) {
        case "ADD_INDEX":
          sql.push(
            `create ${idx.index.unique ? "unique " : ""}index ${q(idx.index.name)} on ${table} (${idx.index.columns.map(q).join(", ")})`,
          );
          break;
        case "DROP_INDEX":
          sql.push(`drop index ${q(idx.index.name)}`);
          break;
      }
    }
    return sql;
  }
}
