import { describe, it, expect } from "vitest";
import { emptySchema } from "../src";
import { SchemaDiffer } from "../src";
import type { Diff } from "../src";
import { Migrator } from "../src";

describe("schema model", () => {
  it("emptySchema 产出空 schema", () => {
    const schema = emptySchema();
    expect(schema.tables.length).toBe(0);
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

  it("Migrator 可实例化（构造不做任何 IO）", () => {
    const migrator = new Migrator({
      files: {} as never,
      history: {} as never,
      executor: {} as never,
      introspector: {} as never,
      ddl: {} as never,
      targetSchema: async () => emptySchema(),
      migrationsDir: "/tmp/migrations",
      lockPath: "/tmp/migrate.lock",
    });
    expect(migrator).toBeDefined();
  });
});
