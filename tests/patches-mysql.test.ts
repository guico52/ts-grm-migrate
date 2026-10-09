/**
 * 真实数据库：列级补丁（`ts-grm-patches` 的 autoIncrement / default）在 MySQL 上的往返。
 *
 * 断言链条：`applyPatches()` + 真实 model(...) → createSchema → 适配器 →
 * MySQL 建表 SQL → 执行 → introspect → **diff 为空**。
 *
 * MySQL 的 catalog 会把默认值改写（数值默认值读回时带引号、`default true` 存成 `1`、
 * 表达式默认值走 DEFAULT_GENERATED），只有真库才能确认两边的写法对得上。
 * 无 MYSQL_HOST 时整体跳过；数据库按随机名创建并删除，不碰 `MYSQL_DATABASE`。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { applyPatches } from "ts-grm-patches";
import {
  EntityManager,
  MySqlDriver,
  createSchema,
  dsl,
  model,
  newSqlClient,
  prop,
} from "../src/vendor/ts-grm";
import type { SqlClientImplementor } from "../src/vendor/ts-grm";
import { tableDefsToSchema } from "../src/schema/adapter";
import { SchemaDiffer } from "../src/differ";
import { MysqlDdlGenerator } from "../src/ddl/mysql";
import { MysqlIntrospector } from "../src/introspector/mysql";
import { MysqlSqlExecutor, type MysqlPoolLike } from "../src/executor/mysql";
import type { Schema } from "../src/schema/model";

const run = process.env.MYSQL_HOST ? describe.sequential : describe.skip;

// 补丁必须在任何 model(...) 定义之前安装
applyPatches();

const ITEM = model(
  "PatchMysqlItem",
  "id",
  class {
    id = prop.i32().autoIncrement();
    status = prop.str(20).default("active");
    createdAt = prop.dt().default(dsl.native.date`now()`);
    active = prop.bool().default(true);
  },
);

const NOTE = model(
  "PatchMysqlNote",
  "id",
  class {
    id = prop.i32();
    body = prop.str(50).default("empty");
  },
);

run("列级补丁（真实 MySQL）", () => {
  let database: string;
  let admin: mysql.Connection;
  let pool: mysql.Pool;
  let created = false;
  const connection = {
    host: process.env.MYSQL_HOST ?? "",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "tgm-test-only",
  };

  beforeEach(async () => {
    created = false;
    database = `tgm_patch_${randomUUID().replaceAll("-", "")}`;
    admin = await mysql.createConnection(connection);
    await admin.query(`create database \`${database}\``);
    created = true;
    pool = mysql.createPool({ ...connection, database, multipleStatements: true });
  });

  afterEach(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (created) await admin.query(`drop database \`${database}\``);
      } finally {
        if (admin) await admin.end();
      }
    }
  });

  it("auto_increment 与默认值建表后 introspect 与模型等价（diff 为空）", async () => {
    const executor = new MysqlSqlExecutor(pool as unknown as MysqlPoolLike);
    const sqlClient = newSqlClient(new MySqlDriver(pool as never), {
      entityManager: EntityManager.combine(ITEM as never, NOTE as never),
    }) as unknown as SqlClientImplementor;

    const tableDefs = await createSchema(sqlClient as never);
    const target = tableDefsToSchema(tableDefs, sqlClient.driver, { dialect: "mysql" });
    const from: Schema = { tables: [] };
    const diff = new SchemaDiffer().diff(from, target);
    const statements = new MysqlDdlGenerator().statements(diff, { from, to: target });
    const itemSql = statements.find((s) => s.includes("PATCH_MYSQL_ITEM"));
    expect(itemSql).toContain("auto_increment");
    expect(itemSql).toContain("default 'active'");
    await executor.executeStatements(statements);

    // 自增主键与默认值真的生效
    await executor.executeStatements([
      "insert into `PATCH_MYSQL_ITEM` (`ID`) values (null)",
    ]);
    const rows = await executor.query(
      "select `ID`, `STATUS`, `ACTIVE`, `CREATED_AT` from `PATCH_MYSQL_ITEM`",
    );
    expect(rows.rows[0]).toMatchObject({ ID: 1, STATUS: "active", ACTIVE: 1 });
    expect(rows.rows[0]?.CREATED_AT).toBeTruthy();

    const actual = await new MysqlIntrospector({ query: executor }).introspect();
    const item = actual.tables.find((t) => t.name === "PATCH_MYSQL_ITEM");
    expect(item?.columns.find((c) => c.name === "ID")?.autoIncrement).toBe(true);

    // 最强断言：catalog 的默认值写法与目标态对齐时，diff 必须为空
    expect(new SchemaDiffer().diff(actual, target).changes).toEqual([]);
  }, 60_000);
});
