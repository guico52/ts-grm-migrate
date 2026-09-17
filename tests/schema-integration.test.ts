import { describe, it, expect } from "vitest";
import { createSchema } from "../src/vendor/ts-grm";
import { tableDefsToSchema } from "../src/schema/adapter";
import { toSnapshot, fromSnapshot } from "../src";
import { createTestSqlClient } from "./util/ts-grm-client";

/**
 * 端到端集成：真实 ts-grm 链路。
 * sqlClient（sqlite 内存 + entityManager）→ createSchema → TableDef[] →
 * 适配器 → Schema → 快照往返。验证「配置 ts-grm 模型即可生成快照」的期望。
 *
 * 实体模型见 tests/model/model.ts，覆盖关联形态：
 * - AUTHOR（id/name/age，o2m 反向 books 不产列）
 * - BOOK（id/title，m2o author → AUTHOR_ID FK 级联删除；m2m tags 拥有侧）
 * - TAG（id/name，m2m 反向）
 * - book_tag_mapping（m2m 中间表：复合主键 + 双 FK）
 */
describe("schema 集成（真实 ts-grm 链路）", () => {
  const sqlClient = createTestSqlClient();

  it("createSchema 产出全部表（含中间表），适配为 Schema 后结构正确", async () => {
    const tableDefs = await createSchema(sqlClient);
    // 上游产出的是「按需加引号」的名字（未加引号 = PG 会折叠为小写）
    expect(tableDefs.map((t) => t.name)).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);

    const schema = tableDefsToSchema(tableDefs, sqlClient.driver);
    // 适配器复刻 PG 的折叠规则，给出数据库里的物理名
    expect(schema.tables.map((t) => t.name)).toEqual(["author", "book", "tag", "book_tag_mapping"]);

    // author：id/name/age + 主键（o2m 反向不产生列）
    const author = schema.tables[0]!;
    expect(author.columns.map((c) => [c.name, c.type, c.nullable, c.ordinal])).toEqual([
      ["id", "integer", false, 1],
      ["name", "text", false, 2],
      ["age", "integer", true, 3],
    ]);
    expect(author.constraints.find((c) => c.kind === "PRIMARY_KEY")!.columns).toEqual(["id"]);

    // book：id/title/author_id + 主键 + 外键（m2o，级联删除）
    const book = schema.tables[1]!;
    expect(book.columns.map((c) => c.name)).toEqual(["id", "title", "author_id"]);
    const bookFk = book.constraints.find((c) => c.kind === "FOREIGN_KEY")!;
    expect(bookFk).toMatchObject({
      columns: ["author_id"],
      referencedTable: "author",
      referencedColumns: ["id"],
      onDelete: "CASCADE",
      cascade: "DELETE",
    });

    // 中间表：复合主键 + 双外键（m2m）
    const mapping = schema.tables[3]!;
    expect(mapping.name).toBe("book_tag_mapping");
    expect(mapping.columns.map((c) => c.name)).toEqual(["book_id", "tag_id"]);
    const mappingPk = mapping.constraints.find((c) => c.kind === "PRIMARY_KEY")!;
    expect(mappingPk.columns).toEqual(["book_id", "tag_id"]);
    expect(mappingPk.implicit).toBe("MIDDLE_TABLE");
    const mappingFks = mapping.constraints.filter((c) => c.kind === "FOREIGN_KEY");
    expect(mappingFks.map((f) => [f.columns, f.referencedTable, f.onDelete])).toEqual([
      [["book_id"], "book", "NO_ACTION"],
      [["tag_id"], "tag", "NO_ACTION"],
    ]);

    // 模型侧无索引/默认值/自增（默认空值，待补充声明机制填充）
    expect(author.indexes).toEqual([]);
    expect(author.columns.every((c) => c.autoIncrement === false && c.default === undefined)).toBe(true);
  });

  it("真实链路快照往返等价", async () => {
    const tableDefs = await createSchema(sqlClient);
    const schema = tableDefsToSchema(tableDefs, sqlClient.driver);
    const json = toSnapshot(schema);
    expect(fromSnapshot(json)).toEqual(schema);
  });

  it("快照内容可读（含表/列/约束）", async () => {
    const tableDefs = await createSchema(sqlClient);
    const schema = tableDefsToSchema(tableDefs, sqlClient.driver);
    const snapshot = JSON.parse(toSnapshot(schema)) as { schema: unknown };
    const json = JSON.stringify(snapshot.schema);
    expect(json).toContain('"name":"author"');
    expect(json).toContain('"name":"book_tag_mapping"');
    expect(json).toContain('"kind":"FOREIGN_KEY"');
    expect(json).toContain('"kind":"PRIMARY_KEY"');
  });
});
