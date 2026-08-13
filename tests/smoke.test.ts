import { describe, it, expect } from "vitest";
import { emptySchema } from "../src/schema/model";
import { SchemaDiffer } from "../src/differ";
import type { Diff } from "../src/diff/types";
import { Migrator } from "../src/migrator";

describe("schema model", () => {
  it("emptySchema 产出空 schema", () => {
    const schema = emptySchema();
    expect(schema.tables.size).toBe(0);
  });
});

describe("differ", () => {
  it("空 schema diff 空 schema 没有变更", () => {
    const differ = new SchemaDiffer();
    const diff = differ.diff(emptySchema(), emptySchema());
    expect(diff.changes).toEqual([]);
    expect(diff.destructive).toEqual([]);
  });
});

describe("类型形状（编译期冒烟）", () => {
  it("diff 的判别联合可被类型守卫收窄", () => {
    const diff: Diff = { changes: [], destructive: [] };
    const kinds = diff.changes.map((c) => c.kind);
    expect(kinds).toEqual([]);
  });

  it("Migrator 可实例化（骨架未实现方法会抛错）", () => {
    const migrator = new Migrator({
      store: {} as never,
      ddl: {} as never,
      executor: {} as never,
      targetSchema: async () => emptySchema(),
    });
    expect(migrator).toBeDefined();
  });
});
