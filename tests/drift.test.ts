import { describe, it, expect } from "vitest";
import { abnormalDrift, describeDiff } from "../src/drift";
import type { Change, Diff } from "../src/diff/types";
import type { Column, Table } from "../src/schema/model";

function diff(changes: ReadonlyArray<Change>): Diff {
  return { changes, destructive: [] };
}

function column(name: string, type = "bigint", ordinal = 1): Column {
  return {
    name,
    type,
    nullable: false,
    length: undefined,
    default: undefined,
    autoIncrement: false,
    ordinal,
    comment: undefined,
  };
}

function table(name: string, columns: ReadonlyArray<Column> = []): Table {
  return { name, columns, constraints: [], indexes: [] };
}

describe("describeDiff（对账报告）", () => {
  it("无差异时报告为空", () => {
    expect(describeDiff(diff([]))).toEqual([]);
  });

  it("缺表 / 多表", () => {
    const drift = describeDiff(
      diff([
        { kind: "CREATE_TABLE", table: table("A") },
        { kind: "DROP_TABLE", table: "B", foreignKeyNames: [] },
      ]),
    );
    expect(drift).toEqual([
      { table: "A", summary: "数据库中不存在这张表", known: false },
      { table: "B", summary: "数据库中多出这张表（模型里已不存在）", known: false },
    ]);
  });

  it("列级差异：缺列 / 多列 / 属性不符", () => {
    const drift = describeDiff(
      diff([
        {
          kind: "ALTER_TABLE",
          table: "T",
          columns: [
            { kind: "ADD_COLUMN", column: column("EMAIL", "text") },
            { kind: "DROP_COLUMN", column: "LEGACY" },
            {
              kind: "ALTER_COLUMN",
              column: "TITLE",
              type: "varchar(100)",
              nullable: undefined,
              default: undefined,
              autoIncrement: undefined,
            },
            {
              kind: "ALTER_COLUMN",
              column: "AGE",
              type: undefined,
              nullable: true,
              default: undefined,
              autoIncrement: undefined,
            },
          ],
          constraints: [],
          indexes: [],
        },
      ]),
    );
    expect(drift.map((d) => d.summary)).toEqual([
      "缺少列 EMAIL",
      "多出列 LEGACY",
      "列 TITLE：类型应为 varchar(100)",
      "列 AGE：应为可空",
    ]);
    expect(drift.every((d) => !d.known)).toBe(true);
  });

  it("列的多项属性差异合并成一条", () => {
    const drift = describeDiff(
      diff([
        {
          kind: "ALTER_TABLE",
          table: "T",
          columns: [
            {
              kind: "ALTER_COLUMN",
              column: "X",
              type: "text",
              nullable: false,
              default: "",
              autoIncrement: undefined,
            },
          ],
          constraints: [],
          indexes: [],
        },
      ]),
    );
    expect(drift[0]!.summary).toBe("列 X：类型应为 text，应为非空，应无默认值");
  });

  it("外键差异带上引用目标", () => {
    const drift = describeDiff(
      diff([
        {
          kind: "ALTER_TABLE",
          table: "BOOK",
          columns: [],
          constraints: [
            {
              kind: "ADD_CONSTRAINT",
              constraint: {
                kind: "FOREIGN_KEY",
                name: "fk",
                columns: ["AUTHOR_ID"],
                referencedTable: "AUTHOR",
                referencedColumns: ["ID"],
                onDelete: "CASCADE",
                deferrable: false,
                cascade: "DELETE",
                implicit: undefined,
              },
            },
          ],
          indexes: [],
        },
      ]),
    );
    expect(drift[0]!.summary).toBe("缺少约束 foreign key (AUTHOR_ID) → AUTHOR");
    expect(drift[0]!.known).toBe(false);
  });

  it("索引差异列出列", () => {
    const drift = describeDiff(
      diff([
        {
          kind: "ALTER_TABLE",
          table: "T",
          columns: [],
          constraints: [],
          indexes: [
            { kind: "ADD_INDEX", index: { name: "IDX", columns: ["A", "B"], unique: false, predicate: undefined } },
            { kind: "DROP_INDEX", index: { name: "OLD", columns: ["C"], unique: true, predicate: undefined } },
          ],
        },
      ]),
    );
    expect(drift.map((d) => d.summary)).toEqual([
      "缺少索引 IDX (A, B)",
      "多出索引 OLD (C)",
    ]);
  });

  it("CHECK 约束标为已知限制，不算异常", () => {
    const drift = describeDiff(
      diff([
        {
          kind: "ALTER_TABLE",
          table: "T",
          columns: [],
          constraints: [
            {
              kind: "ADD_CONSTRAINT",
              constraint: {
                kind: "CHECK",
                name: undefined,
                values: [],
                expression: "((TYPE)::text = ANY (ARRAY['Book'::text]))",
                implicit: undefined,
              },
            },
          ],
          indexes: [],
        },
      ]),
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]!.known).toBe(true);
    expect(drift[0]!.summary).toContain("check (");
    // 关键：已知限制不进入异常列表
    expect(abnormalDrift(drift)).toEqual([]);
  });

  it("长表达式被截断，避免刷屏", () => {
    const long = "x".repeat(200);
    const drift = describeDiff(
      diff([
        {
          kind: "ALTER_TABLE",
          table: "T",
          columns: [],
          constraints: [
            {
              kind: "ADD_CONSTRAINT",
              constraint: { kind: "CHECK", name: undefined, values: [], expression: long, implicit: undefined },
            },
          ],
          indexes: [],
        },
      ]),
    );
    expect(drift[0]!.summary.length).toBeLessThan(120);
    expect(drift[0]!.summary).toContain("…");
  });
});
