/**
 * 真实数据库：删除有外键依赖的表（回归）。
 *
 * 场景来自实测：book / tag / book_tag_mapping 三表一起删时，introspection
 * 走 `order by relname`，字母序让 book 先于中间表被删，PG 报
 * `cannot drop table book because other objects depend on it`，
 * 整个迁移事务回滚。
 *
 * 修法：删表前先摘掉该表自身的外键（`DropTable.foreignKeyNames`），
 * 使各 `drop table` 互相独立、与遍历顺序无关。
 *
 * 无 PG_HOST 时整体跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { lookup } from "node:dns/promises";
import { Pool } from "pg";
import { SchemaDiffer } from "../src/differ";
import { PostgresDdlGenerator } from "../src";
import type { Column, Constraint, Schema, Table as SchemaTable } from "../src/schema/model";

const PG_HOST = process.env.PG_HOST;
const PG_CONFIG = {
  host: PG_HOST ?? "",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "ts_grm_migrate_test",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "",
};

const col = (name: string): Column => ({
  name,
  type: "integer",
  nullable: false,
  length: undefined,
  default: undefined,
  autoIncrement: false,
  ordinal: 1,
  comment: undefined,
});
const pk = (columns: Array<string>): Constraint => ({
  kind: "PRIMARY_KEY",
  name: undefined,
  columns,
  implicit: undefined,
});
const fk = (
  name: string,
  columns: Array<string>,
  referencedTable: string,
  referencedColumns: Array<string>,
): Constraint => ({
  kind: "FOREIGN_KEY",
  name,
  columns,
  referencedTable,
  referencedColumns,
  onDelete: "NO_ACTION",
  deferrable: false,
  cascade: "NONE",
  implicit: undefined,
});
const table = (
  name: string,
  columns: Array<Column>,
  constraints: Array<Constraint>,
): SchemaTable => ({ name, columns, constraints, indexes: [] });

const describePg = PG_HOST != null ? describe : describe.skip;

describePg("DDL 执行（真实数据库）", () => {
  let pool: Pool;
  const schemaName = "ddl_e2e_drop_fk";

  beforeAll(async () => {
    try {
      const { address } = await lookup(PG_HOST ?? "");
      PG_CONFIG.host = address;
    } catch {
      // 解析失败就保留域名，让连接错误自然暴露
    }
    pool = new Pool({ ...PG_CONFIG, max: 2 });
  });

  afterAll(async () => {
    await pool?.query(`drop schema if exists "${schemaName}" cascade`).catch(() => undefined);
    await pool?.end();
  });

  it("三表一起删（中间表引用另外两张）不再因外键依赖失败", async () => {
    const bookTable = table("book", [col("id")], [pk(["id"])]);
    const tagTable = table("tag", [col("id")], [pk(["id"])]);
    const mappingTable = table("book_tag_mapping", [col("book_id"), col("tag_id")], [
      fk("book_tag_mapping_book_id_fkey", ["book_id"], "book", ["id"]),
      fk("book_tag_mapping_tag_id_fkey", ["tag_id"], "tag", ["id"]),
    ]);
    // 建表按依赖顺序（被引用者在前）—— 建表侧的同源问题本次不修
    const buildOrder: Schema = { tables: [bookTable, tagTable, mappingTable] };
    // 删除按 introspection 的字母序给出（book 排在中间表之前），正是触发 bug 的顺序
    const from: Schema = { tables: [bookTable, mappingTable, tagTable] };
    const to: Schema = { tables: [] };

    // search_path 是会话级的，整个用例必须走同一条连接
    const client = await pool.connect();
    try {
      await client.query(`drop schema if exists "${schemaName}" cascade`);
      await client.query(`create schema "${schemaName}"`);
      await client.query(`set search_path to "${schemaName}"`);

      for (const stmt of new PostgresDdlGenerator().createStatements(buildOrder)) {
        await client.query(stmt);
      }

      // 删除：修复前这里会抛 cannot drop table book because other objects depend on it
      const statements = new PostgresDdlGenerator().statements(new SchemaDiffer().diff(from, to));
      for (const stmt of statements) {
        await client.query(stmt);
      }

      const left = await client.query(
        `select table_name from information_schema.tables where table_schema = $1`,
        [schemaName],
      );
      expect(left.rows).toEqual([]);
    } finally {
      client.release();
    }
  }, 60_000);
});
