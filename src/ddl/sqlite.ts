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
          `生成 ${table.name} 建表 SQL 需要方言 driver（原生 toCreationStatements），请传入 DdlGeneratorOptions.driver`,
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
          "-- 提示: SQLite 的 add column 不能是 not null（除非带默认值），如执行失败请改走重建表",
        ];
  }

  /**
   * 重建表路径：drop 旧表 + 原生建表（目标态 TableDef）+ 数据迁移 TODO。
   * 需要目标表结构 → 依赖 tableDefs；SQLite 无法原地 drop column / 改类型 / 改约束。
   */
  private _rebuildTable(tableName: string): ReadonlyArray<string> {
    const tableDef = this._options.tableDefs?.get(tableName);
    if (tableDef == null || this._options.driver == null) {
      throw new Error(
        `SQLite 重建表 "${tableName}" 需要目标态 TableDef 与方言 driver（DdlGeneratorOptions），` +
          `当前无法从 diff 反推完整目标结构`,
      );
    }
    const newColumns = tableDef.columns.map((c) => q(c.name)).join(", ");
    return [
      `-- SQLite 重建表: ${q(tableName)}（drop column / 改类型 / 改约束无法原地执行）`,
      `drop table if exists ${q(tableName)}`,
      ...tableDef.toCreationStatements(this._options.driver),
      `-- 数据迁移 TODO: insert into ${q(tableName)} (${newColumns}) select ${newColumns} from <旧表备份>`,
    ];
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
