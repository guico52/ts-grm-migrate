import { describe, it, expect } from "vitest";
import { SchemaDiffer } from "../src/differ";
import type { Diff } from "../src/diff/types";
import type {
  CheckConstraint,
  Column,
  ForeignKeyConstraint,
  Index,
  PrimaryKeyConstraint,
  Schema,
  Table as SchemaTable,
  UniqueConstraint,
} from "../src/schema/model";

// ---- 构造 helper（与 tests/ddl.test.ts 一致的最小构造） ----------------------

function col(name: string, type: string, nullable = false, def?: string): Column {
  return {
    name,
    type,
    nullable,
    length: undefined,
    default: def,
    autoIncrement: false,
    ordinal: 1,
    comment: undefined,
  };
}

function pk(columns: Array<string>): PrimaryKeyConstraint {
  return { kind: "PRIMARY_KEY", name: undefined, columns, implicit: undefined };
}

function fk(columns: Array<string>, referencedTable: string, referencedColumns: Array<string>, onDelete: ForeignKeyConstraint["onDelete"] = "NO_ACTION"): ForeignKeyConstraint {
  return {
    kind: "FOREIGN_KEY",
    name: undefined,
    columns,
    referencedTable,
    referencedColumns,
    onDelete,
    deferrable: false,
    cascade: onDelete === "CASCADE" ? "DELETE" : "NONE",
    implicit: undefined,
  };
}

function uq(columns: Array<string>): UniqueConstraint {
  return { kind: "UNIQUE", name: undefined, columns, implicit: undefined };
}

function ck(expression: string): CheckConstraint {
  return { kind: "CHECK", name: undefined, expression, values: [], implicit: undefined };
}

function idx(name: string, columns: Array<string>, unique = false): Index {
  return { name, columns, unique, predicate: undefined };
}

function table(name: string, columns: Array<Column>, constraints: SchemaTable["constraints"] = [], indexes: Array<Index> = []): SchemaTable {
  return { name, columns, constraints, indexes };
}

function schema(tables: Array<SchemaTable>): Schema {
  return { tables };
}

const differ = new SchemaDiffer();

// ---- 表级别 ----------------------------------------------------------------

describe("SchemaDiffer 表级别", () => {
  it("空 vs 空：无变更", () => {
    expect(differ.diff(empty(), empty())).toEqual({ changes: [], destructive: [] });
  });

  it("新增表 → CREATE_TABLE（非破坏）", () => {
    const d = differ.diff(empty(), schema([table("A", [col("ID", "integer")], [pk(["ID"])])]));
    expect(d.changes).toEqual([
      { kind: "CREATE_TABLE", table: table("A", [col("ID", "integer")], [pk(["ID"])]) },
    ]);
    expect(d.destructive).toEqual([]);
  });

  it("删除表 → DROP_TABLE（破坏）", () => {
    const from = schema([table("A", [col("ID", "integer")])]);
    const d = differ.diff(from, empty());
    expect(d.changes).toEqual([{ kind: "DROP_TABLE", table: "A", foreignKeyNames: [] }]);
    expect(d.destructive).toEqual([{ kind: "DROP_TABLE", table: "A", foreignKeyNames: [] }]);
  });

  it("删除有外键的表 → 带上该表自身的外键名（供 DDL 先摘掉）", () => {
    const from = schema([
      table("A", [col("ID", "integer")], [pk(["ID"])]),
      table("B", [col("ID", "integer"), col("A_ID", "integer")], [
        pk(["ID"]),
        { ...fk(["A_ID"], "A", ["ID"]), name: "b_a_id_fkey" },
      ]),
    ]);

    const d = differ.diff(from, empty());

    // A 自己没有外键；B 的指向 A —— DDL 必须先把 B 的外键摘掉，
    // 否则字母序下先删 A 会被 B 的外键拦住（实测 PG 报错并回滚迁移）。
    expect(d.changes).toEqual([
      { kind: "DROP_TABLE", table: "A", foreignKeyNames: [] },
      { kind: "DROP_TABLE", table: "B", foreignKeyNames: ["b_a_id_fkey"] },
    ]);
  });
});

// ---- 列级别 ----------------------------------------------------------------

describe("SchemaDiffer 列级别", () => {
  const base = table("A", [col("ID", "integer"), col("NAME", "text")]);

  it("加列 → ADD_COLUMN", () => {
    const to = table("A", [col("ID", "integer"), col("NAME", "text"), col("AGE", "integer", true)]);
    const d = differ.diff(schema([base]), schema([to]));
    expect(d.changes).toEqual([
      { kind: "ALTER_TABLE", table: "A", columns: [{ kind: "ADD_COLUMN", column: col("AGE", "integer", true) }], constraints: [], indexes: [] },
    ]);
    expect(d.destructive).toEqual([]);
  });

  it("删列 → DROP_COLUMN（破坏）", () => {
    const from = table("A", [col("ID", "integer"), col("LEGACY", "text")]);
    const to = table("A", [col("ID", "integer")]);
    const d = differ.diff(schema([from]), schema([to]));
    expect(d.changes).toEqual([
      { kind: "ALTER_TABLE", table: "A", columns: [{ kind: "DROP_COLUMN", column: "LEGACY" }], constraints: [], indexes: [] },
    ]);
    expect(d.destructive).toEqual([{ kind: "DROP_COLUMN", table: "A", column: "LEGACY" }]);
  });

  it("改类型 → ALTER_COLUMN（破坏）", () => {
    const d = differ.diff(schema([base]), schema([table("A", [col("ID", "bigint"), col("NAME", "text")])]));
    const alter = d.changes[0] as Extract<Diff["changes"][number], { kind: "ALTER_TABLE" }>;
    expect(alter.columns).toEqual([
      { kind: "ALTER_COLUMN", column: "ID", type: "bigint", nullable: undefined, default: undefined, autoIncrement: undefined },
    ]);
    expect(d.destructive).toEqual([{ kind: "ALTER_COLUMN", table: "A", column: "ID", type: "bigint" }]);
  });

  it("改 nullable → ALTER_COLUMN（非破坏）", () => {
    const d = differ.diff(schema([base]), schema([table("A", [col("ID", "integer"), col("NAME", "text", true)])]));
    const alter = d.changes[0] as Extract<Diff["changes"][number], { kind: "ALTER_TABLE" }>;
    expect(alter.columns).toEqual([
      { kind: "ALTER_COLUMN", column: "NAME", type: undefined, nullable: true, default: undefined, autoIncrement: undefined },
    ]);
    expect(d.destructive).toEqual([]);
  });

  it("default 不管理：现状有默认值、目标无 → 无变更", () => {
    const from = table("A", [col("ID", "integer"), col("NAME", "text", false, "'x'")]);
    const to = table("A", [col("ID", "integer"), col("NAME", "text")]);
    expect(differ.diff(schema([from]), schema([to])).changes).toEqual([]);
  });

  it("default 设置 / 删除：目标有值才参与 diff", () => {
    // 目标设置默认值（现状无）
    let d = differ.diff(schema([base]), schema([table("A", [col("ID", "integer"), col("NAME", "text", false, "'untitled'")])]));
    expect(d.changes).toEqual([
      { kind: "ALTER_TABLE", table: "A", columns: [{ kind: "ALTER_COLUMN", column: "NAME", type: undefined, nullable: undefined, default: "'untitled'", autoIncrement: undefined }], constraints: [], indexes: [] },
    ]);
    // 目标 "" = 删除默认值
    d = differ.diff(schema([table("A", [col("ID", "integer"), col("NAME", "text", false, "'untitled'")])]), schema([table("A", [col("ID", "integer"), col("NAME", "text", false, "")])]));
    const alter = d.changes[0] as Extract<Diff["changes"][number], { kind: "ALTER_TABLE" }>;
    expect(alter.columns).toEqual([
      { kind: "ALTER_COLUMN", column: "NAME", type: undefined, nullable: undefined, default: "", autoIncrement: undefined },
    ]);
  });

  it("列顺序差异忽略", () => {
    const from = table("A", [col("ID", "integer"), col("NAME", "text")]);
    const to = table("A", [col("NAME", "text"), col("ID", "integer")]);
    expect(differ.diff(schema([from]), schema([to])).changes).toEqual([]);
  });
});

// ---- 约束 / 索引 -----------------------------------------------------------

describe("SchemaDiffer 约束与索引", () => {
  it("约束按内容匹配：名字不同但内容相同 → 无变更", () => {
    const from = table("A", [col("ID", "integer")], [
      { ...pk(["ID"]), name: "old_pk" },
    ]);
    const to = table("A", [col("ID", "integer")], [
      { ...pk(["ID"]), name: "new_pk" },
    ]);
    expect(differ.diff(schema([from]), schema([to])).changes).toEqual([]);
  });

  it("FK 级联变化 → DROP + ADD", () => {
    const from = table("B", [col("ID", "integer"), col("A_ID", "integer")], [
      pk(["ID"]),
      fk(["A_ID"], "A", ["ID"], "NO_ACTION"),
    ]);
    const to = table("B", [col("ID", "integer"), col("A_ID", "integer")], [
      pk(["ID"]),
      fk(["A_ID"], "A", ["ID"], "CASCADE"),
    ]);
    const d = differ.diff(schema([from]), schema([to]));
    const alter = d.changes[0] as Extract<Diff["changes"][number], { kind: "ALTER_TABLE" }>;
    expect(alter.constraints).toEqual([
      { kind: "DROP_CONSTRAINT", constraint: fk(["A_ID"], "A", ["ID"], "NO_ACTION") },
      { kind: "ADD_CONSTRAINT", constraint: fk(["A_ID"], "A", ["ID"], "CASCADE") },
    ]);
    expect(d.destructive).toEqual([]);
  });

  it("CHECK 表达式变化 → DROP + ADD", () => {
    const from = table("B", [col("PRICE", "real")], [ck("PRICE > 0")]);
    const to = table("B", [col("PRICE", "real")], [ck("PRICE >= 0")]);
    const alter = differ.diff(schema([from]), schema([to])).changes[0] as Extract<Diff["changes"][number], { kind: "ALTER_TABLE" }>;
    expect(alter.constraints).toEqual([
      { kind: "DROP_CONSTRAINT", constraint: ck("PRICE > 0") },
      { kind: "ADD_CONSTRAINT", constraint: ck("PRICE >= 0") },
    ]);
  });

  it("索引增删（内容匹配）", () => {
    const from = table("A", [col("ID", "integer"), col("NAME", "text")], [], [idx("x", ["NAME"])]);
    const to = table("A", [col("ID", "integer"), col("NAME", "text")], [], [idx("y", ["NAME", "ID"])]);
    const alter = differ.diff(schema([from]), schema([to])).changes[0] as Extract<Diff["changes"][number], { kind: "ALTER_TABLE" }>;
    expect(alter.indexes).toEqual([
      { kind: "DROP_INDEX", index: idx("x", ["NAME"]) },
      { kind: "ADD_INDEX", index: idx("y", ["NAME", "ID"]) },
    ]);
  });
});

function empty(): Schema {
  return schema([]);
}
