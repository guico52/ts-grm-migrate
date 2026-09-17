/**
 * Postgres Introspector 集成测试 —— **需要真实数据库**，无 PG_HOST 时整体跳过。
 *
 * 连接信息全部来自环境变量（同 tests/manual-postgres.test.ts）：
 *   PG_HOST（必填，未设置则跳过） / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD
 *
 * 运行：`PG_HOST=... PG_PASSWORD=... yarn vitest run tests/introspector-postgres.test.ts`
 *
 * 核心断言：**「模型建的表，introspect 回来与目标态等价」——即 diff 为空**。
 * 这是类型对齐（introspector 的 type 字符串 vs ts-grm `PostgresDriver.typeName()`）
 * 最有力的验证：只要有一处写法不一致，`SchemaDiffer` 就会报出 ALTER_COLUMN。
 *
 * 用独立 schema 隔离，不触碰 public，结束即清理。
 */
import { describe, it, expect, afterAll } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PostgresIntrospector } from "../src";
import type { SqlQueryable } from "../src";
import { PostgresDdlGenerator } from "../src";
import { SchemaDiffer } from "../src";
import { createSchema } from "../src/vendor/ts-grm";
import { tableDefsToSchema } from "../src";
import type { Schema } from "../src";
import { createTestPostgresClient } from "./util/ts-grm-client";

const PG_HOST = process.env.PG_HOST;
const PG_CONFIG = {
  host: PG_HOST ?? "",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "ts_grm_migrate_test",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "",
};

/** 集成测试专用 schema，避免污染 public */
const TEST_SCHEMA = "ts_grm_migrate_introspect";

const describePg = PG_HOST != null ? describe.sequential : describe.skip;

describePg("PostgresIntrospector 集成（真实数据库）", () => {
  const { sqlClient, pool } = createTestPostgresClient(PG_CONFIG);
  afterAll(() => pool.end());

  /** 在干净 schema 里跑（search_path 指向它，建表 SQL 不带 schema 前缀也能落对位置） */
  async function inFreshSchema<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`drop schema if exists "${TEST_SCHEMA}" cascade`);
      await client.query(`create schema "${TEST_SCHEMA}"`);
      await client.query(`set search_path to "${TEST_SCHEMA}"`);
      return await fn(client);
    } finally {
      await client
        .query(`drop schema if exists "${TEST_SCHEMA}" cascade`)
        .catch(() => undefined);
      client.release();
    }
  }

  /** 目标态：ts-grm 模型 → Schema（走适配器，与真实链路一致） */
  async function targetSchema(): Promise<Schema> {
    const tableDefs = await createSchema(sqlClient);
    return tableDefsToSchema(tableDefs, sqlClient.driver);
  }

  function introspector(client: PoolClient): PostgresIntrospector {
    return new PostgresIntrospector({
      query: client as unknown as SqlQueryable,
      schema: TEST_SCHEMA,
    });
  }

  it("模型建的表 introspect 回来与目标态等价（diff 为空）", async () => {
    await inFreshSchema(async (client) => {
      const target = await targetSchema();
      for (const sql of new PostgresDdlGenerator().createStatements(target)) {
        await client.query(sql);
      }

      const actual = await introspector(client).introspect();

      // 表集合一致
      expect(actual.tables.map((t) => t.name).sort()).toEqual(
        target.tables.map((t) => t.name).sort(),
      );

      // 最强断言：类型/可空性/约束/索引全部对齐时，diff 必须为空
      const diff = new SchemaDiffer().diff(actual, target);
      expect(diff.changes).toEqual([]);
    });
  });

  it("逐列核对类型字符串（定位对齐失败时的具体列）", async () => {
    await inFreshSchema(async (client) => {
      const target = await targetSchema();
      for (const sql of new PostgresDdlGenerator().createStatements(target)) {
        await client.query(sql);
      }

      const actual = await introspector(client).introspect();
      const actualByName = new Map(actual.tables.map((t) => [t.name, t]));

      for (const targetTable of target.tables) {
        const actualTable = actualByName.get(targetTable.name);
        expect(actualTable, `表 ${targetTable.name} 应被读出`).toBeDefined();
        const actualColumns = new Map(
          (actualTable?.columns ?? []).map((c) => [
            c.name,
            { type: c.type, nullable: c.nullable },
          ]),
        );
        for (const targetColumn of targetTable.columns) {
          expect(
            actualColumns.get(targetColumn.name),
            `${targetTable.name}.${targetColumn.name} 的类型/可空性应与模型一致`,
          ).toEqual({ type: targetColumn.type, nullable: targetColumn.nullable });
        }
      }
    });
  });

  it("外键读到引用表/列，与目标态按内容匹配", async () => {
    await inFreshSchema(async (client) => {
      const target = await targetSchema();
      for (const sql of new PostgresDdlGenerator().createStatements(target)) {
        await client.query(sql);
      }

      const actual = await introspector(client).introspect();
      const actualFks = actual.tables.flatMap((t) =>
        t.constraints.filter((c) => c.kind === "FOREIGN_KEY"),
      );
      const targetFks = target.tables.flatMap((t) =>
        t.constraints.filter((c) => c.kind === "FOREIGN_KEY"),
      );

      expect(actualFks.length).toBe(targetFks.length);
      for (const targetFk of targetFks) {
        const match = actualFks.find(
          (actualFk) =>
            actualFk.kind === "FOREIGN_KEY" &&
            targetFk.kind === "FOREIGN_KEY" &&
            actualFk.columns.join(",") === targetFk.columns.join(",") &&
            actualFk.referencedTable === targetFk.referencedTable,
        );
        expect(match, `外键 ${targetFk.columns.join(",")} 应被读出`).toBeDefined();
      }
    });
  });

  it("introspect 结果可序列化为快照（与目标态走同一形状）", async () => {
    await inFreshSchema(async (client) => {
      const target = await targetSchema();
      for (const sql of new PostgresDdlGenerator().createStatements(target)) {
        await client.query(sql);
      }
      const actual = await introspector(client).introspect();
      // 现状也要能进快照链路（isSchema 校验会检查每个字段）
      const { toSnapshot, fromSnapshot } = await import("../src/snapshot");
      expect(fromSnapshot(toSnapshot(actual))).toEqual(actual);
    });
  });
});
