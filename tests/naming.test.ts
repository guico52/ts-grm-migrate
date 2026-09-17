import { it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  createSchema,
  EntityManager,
  model,
  newSqlClient,
  prop,
  SqliteDriver,
} from "../src/vendor/ts-grm";

/**
 * 表名/列名的**来源**（记录上游契约，防止误判为 migrate 的缺陷）。
 *
 * ts-grm 的命名规则是「**显式声明优先，其余走命名策略**」：
 * - 实体表与实体列：由 `DatabaseNamingStrategy` 生成。默认策略构造参数 `lower=false`，
 *   即 `UPPER_SNAKE_CASE`（`packages/core/src/impl/strategy.ts:98`）
 * - 中间表（m2m）的表名与两列：`notEmpty(baseStorage.name, () => strategy...middleTableName(...))`
 *   —— 模型里**显式写了就原样用、不做大小写转换**（`entity_prop.ts:1075`）
 *
 * 所以「实体全大写、中间表全小写」只说明那套模型的中间表是显式声明的。
 * migrate 对名字零加工，并且 DDL 一律给标识符加引号（PG 不加引号会折叠为小写，
 * 反而与模型不一致）。
 */

// 第一组：m2m 显式声明 joinTable（故意用小写，模拟常见写法）
const TagExplicit = model("TagExplicit", "id", class {
  id = prop.i64();
  books = prop.m2m(BookExplicit).mappedBy("tags");
});

const BookExplicit = model("BookExplicit", "id", class {
  id = prop.i64();
  tags = prop.m2m(TagExplicit).joinTable({
    name: "custom_lower_mapping",
    joinThisColumns: ["book_lower_id"],
    joinTargetColumns: ["tag_lower_id"],
  });
});

// 第二组：m2m 不声明 joinTable（完全交给命名策略）
const TagDefault = model("TagDefault", "id", class {
  id = prop.i64();
  books = prop.m2m(BookDefault).mappedBy("tags");
});

const BookDefault = model("BookDefault", "id", class {
  id = prop.i64();
  tags = prop.m2m(TagDefault);
});

async function tableNames(): Promise<Map<string, ReadonlyArray<string>>> {
  const db = new Database(":memory:");
  const client = newSqlClient(new SqliteDriver(db), {
    entityManager: EntityManager.combine(
      EntityManager.combine(BookExplicit, TagExplicit),
      EntityManager.combine(BookDefault, TagDefault),
    ),
  });
  const tableDefs = await createSchema(client as never);
  const map = new Map<string, ReadonlyArray<string>>();
  for (const table of tableDefs) {
    map.set(
      table.name,
      table.columns.map((c) => c.name),
    );
  }
  db.close();
  return map;
}

it("实体表与实体列走命名策略（默认 UPPER_SNAKE_CASE）", async () => {
  const tables = await tableNames();
  expect(tables.get("BOOK_EXPLICIT")).toEqual(["ID"]);
  expect(tables.get("TAG_EXPLICIT")).toEqual(["ID"]);
  expect(tables.get("BOOK_DEFAULT")).toEqual(["ID"]);
});

it("显式声明的中间表：表名与列名原样保留（不做大小写转换）", async () => {
  const tables = await tableNames();
  expect(tables.get("custom_lower_mapping")).toEqual(["book_lower_id", "tag_lower_id"]);
});

it("未声明的中间表：同样走命名策略（后缀 MAPPING、列名大写）", async () => {
  const tables = await tableNames();
  expect(tables.get("BOOK_DEFAULT_TAG_DEFAULT_MAPPING")).toEqual([
    "BOOK_DEFAULT_ID",
    "TAG_DEFAULT_ID",
  ]);
});
