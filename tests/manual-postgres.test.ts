import { describe, it, expect, afterAll } from "vitest";
import type { Pool } from "pg";
import { createSchema } from "../src/vendor/ts-grm";
import { tableDefsToSchema } from "../src/schema/adapter";
import { SchemaDiffer } from "../src/differ";
import { PostgresDdlGenerator } from "../src/ddl/postgres";
import { toSnapshot, fromSnapshot } from "../src";
import type { Column, Schema, Table as SchemaTable } from "../src/schema/model";
import { createTestPostgresClient } from "./util/ts-grm-client";

/**
 * 手动测试：Postgres 数据库初始化 / 变更。
 *
 * 连接信息**全部来自环境变量，文件内无硬编码凭据**：
 * - `PG_HOST`     目标主机（必填；未设置则整个文件跳过）
 * - `PG_PORT`     端口（默认 5432）
 * - `PG_DATABASE` 库名（默认 ts_grm_migrate_test）
 * - `PG_USER`     用户（默认 postgres）
 * - `PG_PASSWORD` 密码（默认空，本地 trust 认证可用）
 *
 * 运行：`PG_HOST=... PG_PASSWORD=... yarn vitest run tests/manual-postgres.test.ts`
 * 依次执行：
 * 1) 初始化建表（AUTHOR/BOOK/TAG/book_tag_mapping）
 * 2) 加列（EMAIL/PUBLISHED）+ 加索引（AUTHOR_NAME_IDX）
 * 3) 删列（AUTHOR.AGE）+ 删索引（AUTHOR_NAME_IDX）+ 加唯一索引（AUTHOR_NAME_UQ_IDX）
 * 全部 SQL 打印输出，数据库表保留不清理，方便你在数据库端追踪结果。
 */
const PG_HOST = process.env.PG_HOST;
const PG_CONFIG = {
  host: PG_HOST ?? "",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "ts_grm_migrate_test",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "",
};

// ---- 执行与验证辅助 --------------------------------------------------------

async function executeStatements(pool: Pool, statements: ReadonlyArray<string>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const sql of statements) {
      await client.query(sql);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function tableExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = $1",
    [name],
  );
  return rows[0]!.n > 0;
}

async function columnExists(pool: Pool, table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    "select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
    [table, column],
  );
  return rows[0]!.n > 0;
}

async function indexExists(pool: Pool, table: string, index: string): Promise<boolean> {
  const { rows } = await pool.query(
    "select count(*)::int as n from pg_indexes where tablename = $1 and indexname = $2",
    [table, index],
  );
  return rows[0]!.n > 0;
}

function makeColumn(name: string, type: string, nullable: boolean): Column {
  return {
    name,
    type,
    nullable,
    length: undefined,
    default: undefined,
    autoIncrement: false,
    ordinal: 1,
    comment: undefined,
  };
}

/** 目标态（当前模型）走快照往返，模拟真实链路 */
async function targetSchema(sqlClient: ReturnType<typeof createTestPostgresClient>["sqlClient"]): Promise<Schema> {
  const tableDefs = await createSchema(sqlClient);
  const schema = tableDefsToSchema(tableDefs, sqlClient.driver);
  return fromSnapshot(toSnapshot(schema));
}

/** 模拟「下一版本」目标：AUTHOR 加 EMAIL 列 + 索引，BOOK 加 PUBLISHED 列 */
function nextVersionSchema(base: Schema): Schema {
  const clone = (t: SchemaTable, patch: Partial<SchemaTable>): SchemaTable => ({
    ...t,
    ...patch,
    columns: patch.columns ?? t.columns,
    constraints: patch.constraints ?? t.constraints,
    indexes: patch.indexes ?? t.indexes,
  });
  return {
    tables: base.tables.map((t) => {
      if (t.name === "AUTHOR") {
        return clone(t, {
          columns: [...t.columns, makeColumn("EMAIL", "text", true)],
          indexes: [{ name: "AUTHOR_NAME_IDX", columns: ["NAME"], unique: false, predicate: undefined }],
        });
      }
      if (t.name === "BOOK") {
        return clone(t, { columns: [...t.columns, makeColumn("PUBLISHED", "boolean", false)] });
      }
      return t;
    }),
  };
}

/** 模拟「再下一版本」目标：AUTHOR 删 AGE 列、删 NAME_IDX、加唯一索引 NAME_UQ */
function nextNextVersionSchema(prev: Schema): Schema {
  return {
    tables: prev.tables.map((t) => {
      if (t.name === "AUTHOR") {
        return {
          ...t,
          columns: t.columns.filter((c) => c.name !== "AGE"),
          indexes: [
            { name: "AUTHOR_NAME_UQ_IDX", columns: ["NAME"], unique: true, predicate: undefined },
          ],
        };
      }
      return t;
    }),
  };
}

// ---- 手动测试 --------------------------------------------------------------

// 无 PG_HOST 时整体跳过（不建立连接）；设置则顺序执行（用例间有状态依赖）
const describePg = PG_HOST != null ? describe.sequential : describe.skip;
describePg("手动测试：Postgres 初始化与变更", () => {
  const { sqlClient, pool } = createTestPostgresClient(PG_CONFIG);
  afterAll(() => pool.end());

  /** 变更 A 后的目标态（测试 2 产生，测试 3 依赖） */
  let version1: Schema | undefined;

  it("初始化：从模型生成并应用全部建表 SQL", async () => {
    // 幂等清理（保留子表先删）
    await pool.query(
      'drop table if exists "book_tag_mapping", "TAG", "BOOK", "AUTHOR" cascade',
    );

    const schema = await targetSchema(sqlClient);
    const gen = new PostgresDdlGenerator();
    const statements = gen.createStatements(schema);

    console.log("\n===== 初始化 SQL =====");
    console.log(statements.join(";\n"));
    await executeStatements(pool, statements);

    // 验证：4 张表 + 关键列
    for (const name of ["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]) {
      expect(await tableExists(pool, name), `表 ${name} 应存在`).toBe(true);
    }
    expect(await columnExists(pool, "BOOK", "AUTHOR_ID")).toBe(true);
  });

  it("变更：diff 生成增量 SQL 并应用（加列 / 加索引）", async () => {
    const base = await targetSchema(sqlClient);
    const next = nextVersionSchema(base);
    version1 = next;

    const diff = new SchemaDiffer().diff(base, next);
    const statements = new PostgresDdlGenerator().statements(diff);

    console.log("\n===== 增量 SQL（加列 / 加索引） =====");
    console.log(statements.join(";\n"));
    await executeStatements(pool, statements);

    // 验证：新列与索引已生效
    expect(await columnExists(pool, "AUTHOR", "EMAIL")).toBe(true);
    expect(await columnExists(pool, "BOOK", "PUBLISHED")).toBe(true);
    expect(await indexExists(pool, "AUTHOR", "AUTHOR_NAME_IDX")).toBe(true);
    // 无破坏性操作
    expect(diff.destructive).toEqual([]);
  });

  it("变更：删除列、删除索引并添加新索引", async () => {
    const prev = version1!;
    const next = nextNextVersionSchema(prev);

    const diff = new SchemaDiffer().diff(prev, next);
    const statements = new PostgresDdlGenerator().statements(diff);

    console.log("\n===== 增量 SQL（删列 / 换索引） =====");
    console.log(statements.join(";\n"));
    await executeStatements(pool, statements);

    // 验证：AGE 列已删除、旧索引已删除、新唯一索引已创建
    expect(await columnExists(pool, "AUTHOR", "AGE")).toBe(false);
    expect(await indexExists(pool, "AUTHOR", "AUTHOR_NAME_IDX")).toBe(false);
    expect(await indexExists(pool, "AUTHOR", "AUTHOR_NAME_UQ_IDX")).toBe(true);
    // 删列是破坏性操作
    expect(diff.destructive).toEqual([
      { kind: "DROP_COLUMN", table: "AUTHOR", column: "AGE" },
    ]);
  });
});
