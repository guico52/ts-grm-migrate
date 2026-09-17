import { describe, it, expect } from "vitest";
import { createSchema } from "../src/vendor/ts-grm";
import { tableDefsToSchema } from "../src/schema/adapter";
import { toSnapshot, fromSnapshot } from "../src";
import { createTestSqlClient } from "./util/ts-grm-client";

/**
 * 快照 JSON 输出 —— 演示/验证端到端效果。
 * 真实链路：实体模型（tests/model/，含 m2o/o2m/m2m 关联）→ createSchema →
 * TableDef[] → 适配器 → Schema → toSnapshot() 快照 JSON。
 *
 * 运行 `yarn test` 或 `yarn vitest run tests/snapshot-output.test.ts`
 * 即可在终端看到完整快照 JSON（见本用例的 console.log 输出）。
 */
describe("快照 JSON 输出", () => {
  it("输出真实链路生成的快照 JSON", async () => {
    const sqlClient = createTestSqlClient();
    const tableDefs = await createSchema(sqlClient);
    const schema = tableDefsToSchema(tableDefs, sqlClient.driver);
    const json = toSnapshot(schema);

    // 输出到终端（vitest 会显示本文件 stdout）
    console.log("\n===== 快照 JSON =====\n" + json + "\n======================");

    // 断言：格式正确、结构符合预期、可反序列化往返
    const parsed = JSON.parse(json) as {
      formatVersion: number;
      schema: { tables: ReadonlyArray<{ name: string }> };
    };
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.schema.tables.map((t) => t.name)).toEqual([
      "AUTHOR",
      "BOOK",
      "TAG",
      "book_tag_mapping",
    ]);
    expect(fromSnapshot(json)).toEqual(schema);
  });
});
