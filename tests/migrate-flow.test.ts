import { describe, it, expect } from "vitest";
import { createSchema } from "../src/vendor/ts-grm";
import { tableDefsToSchema } from "../src/schema/adapter";
import { toSnapshot, fromSnapshot } from "../src";
import { SchemaDiffer } from "../src/differ";
import { PostgresDdlGenerator } from "../src/ddl/postgres";
import type { Schema } from "../src/schema/model";
import { createTestSqlClient } from "./util/ts-grm-client";

/**
 * 端到端迁移链路（增量路径）：
 * 模型 → createSchema → 适配器 → 目标态 Schema → 快照 → 反序列化 →
 * diff（vs 手工构造的现状）→ Postgres 增量 SQL。
 *
 * 模拟「模型升级」：现状 = 旧版本结构（AUTHOR 无 AGE、BOOK 无 AUTHOR_ID/FK、
 * 无 TAG、无中间表），目标 = tests/model/ 的新模型。
 */
describe("迁移链路（模型 → 快照 → diff → SQL）", () => {
  const sqlClient = createTestSqlClient();

  async function targetSchema(): Promise<Schema> {
    const tableDefs = await createSchema(sqlClient);
    const schema = tableDefsToSchema(tableDefs, sqlClient.driver);
    // 目标态走一遍快照序列化 → 反序列化，验证快照参与链路
    return fromSnapshot(toSnapshot(schema));
  }

  /** 现状：旧版本结构（与目标同方言类型映射：sqlite 的 integer/text） */
  function fromSchema(): Schema {
    return {
      tables: [
        {
          name: "AUTHOR",
          columns: [
            { name: "ID", type: "integer", nullable: false, length: undefined, default: undefined, autoIncrement: false, ordinal: 1, comment: undefined },
            { name: "NAME", type: "text", nullable: false, length: undefined, default: undefined, autoIncrement: false, ordinal: 2, comment: undefined },
          ],
          constraints: [{ kind: "PRIMARY_KEY", name: undefined, columns: ["ID"], implicit: undefined }],
          indexes: [],
        },
        {
          name: "BOOK",
          columns: [
            { name: "ID", type: "integer", nullable: false, length: undefined, default: undefined, autoIncrement: false, ordinal: 1, comment: undefined },
            { name: "TITLE", type: "text", nullable: false, length: undefined, default: undefined, autoIncrement: false, ordinal: 2, comment: undefined },
          ],
          constraints: [{ kind: "PRIMARY_KEY", name: undefined, columns: ["ID"], implicit: undefined }],
          indexes: [],
        },
      ],
    };
  }

  it("diff 产出预期的结构变更（新表 + 加列 + 外键）", async () => {
    const diff = new SchemaDiffer().diff(fromSchema(), await targetSchema());

    const byKind = new Map<string, number>();
    for (const change of diff.changes) {
      byKind.set(change.kind, (byKind.get(change.kind) ?? 0) + 1);
    }
    expect(byKind.get("CREATE_TABLE")).toBe(2); // TAG + book_tag_mapping
    expect(byKind.get("ALTER_TABLE")).toBe(2); // AUTHOR + BOOK

    const authorAlter = diff.changes.find(
      (c): c is Extract<typeof c, { kind: "ALTER_TABLE" }> => c.kind === "ALTER_TABLE" && c.table === "AUTHOR",
    )!;
    expect(authorAlter.columns).toEqual([
      { kind: "ADD_COLUMN", column: expect.objectContaining({ name: "AGE", type: "integer", nullable: true }) },
    ]);

    const bookAlter = diff.changes.find(
      (c): c is Extract<typeof c, { kind: "ALTER_TABLE" }> => c.kind === "ALTER_TABLE" && c.table === "BOOK",
    )!;
    expect(bookAlter.columns).toEqual([
      { kind: "ADD_COLUMN", column: expect.objectContaining({ name: "AUTHOR_ID", nullable: true }) },
    ]);
    expect(bookAlter.constraints).toEqual([
      {
        kind: "ADD_CONSTRAINT",
        constraint: expect.objectContaining({
          kind: "FOREIGN_KEY",
          columns: ["AUTHOR_ID"],
          referencedTable: "AUTHOR",
          onDelete: "CASCADE",
        }),
      },
    ]);
  });

  it("增量 SQL 生成完整（加列 / 外键 / 新表）", async () => {
    const diff = new SchemaDiffer().diff(fromSchema(), await targetSchema());
    const sql = new PostgresDdlGenerator().statements(diff);

    const joined = sql.join("\n");
    expect(joined).toContain('alter table "AUTHOR" add column "AGE" integer null');
    expect(joined).toContain('alter table "BOOK" add column "AUTHOR_ID" integer null');
    expect(joined).toContain(
      'alter table "BOOK" add constraint "BOOK_fk_AUTHOR_ID" foreign key ("AUTHOR_ID") references "AUTHOR" ("ID") on delete cascade',
    );
    expect(joined).toContain('create table "TAG"');
    expect(joined).toContain('create table "book_tag_mapping"');
  });

  it("破坏性标注：加列/加表/加约束均为非破坏", async () => {
    const diff = new SchemaDiffer().diff(fromSchema(), await targetSchema());
    expect(diff.destructive).toEqual([]);
  });
});
