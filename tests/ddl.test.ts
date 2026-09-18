import { describe, it, expect } from "vitest";
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
import type { Diff } from "../src/diff/types";
import {
  PostgresDdlGenerator,
  SqliteDdlGenerator,
  type DdlGeneratorOptions,
} from "../src";
import { ScalarType, type TableDef, type ColumnDef } from "../src/vendor/ts-grm";
import type { SchemaDriver } from "../src/schema/adapter";

// ---- 构造 helper -----------------------------------------------------------

function col(name: string, type: string, nullable = false, comment?: string): Column {
  return {
    name,
    type,
    nullable,
    length: undefined,
    default: undefined,
    autoIncrement: false,
    ordinal: 1,
    comment,
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
    cascade: onDelete === "CASCADE" ? "DELETE" : onDelete === "SET_NULL" ? "SET_NULL" : "NONE",
    implicit: undefined,
  };
}

function uq(columns: Array<string>): UniqueConstraint {
  return { kind: "UNIQUE", name: undefined, columns, implicit: undefined };
}

function ck(expression: string, values: Array<string | number> = []): CheckConstraint {
  return { kind: "CHECK", name: undefined, expression, values, implicit: undefined };
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

function diff(changes: Diff["changes"]): Diff {
  return { changes, destructive: [] };
}

// 真实链路的 TableDef 构造（模拟 createSchema 产物，供原生建表路径）
type MutableTableDef = TableDef & {
  columns: Array<ColumnDef>;
  constraints: Array<TableDef["constraints"][number]>;
};

function makeTableDef(name: string, columns: Array<[string, string, boolean]>): TableDef {
  const td: MutableTableDef = {
    entity: undefined,
    prop: undefined,
    name,
    columns: [],
    constraints: [],
    // 模拟 ts-grm 原生 toCreationStatements 的输出形态（列 + 主键约束）
    toCreationStatements: () => [
      `create table ${name}(\n    ${columns
        .map(([n, kind, nullable]) => `${n} ${kind === "STR" ? "text" : "integer"} ${nullable ? "null" : "not null"}`)
        .join(", ")},\n\n    constraint ${name}_constraint_1\n        primary key(${columns[0]![0]})\n)`,
    ],
    toDeletionStatements: () => [],
  } as unknown as MutableTableDef;
  td.columns = columns.map(([n, kind, nullable]) => ({
    declaringTable: td,
    prop: undefined,
    name: n,
    type: kind === "STR" ? ScalarType.str(50) : ScalarType.I32,
    nullable,
    length: kind === "STR" ? 50 : undefined,
    when: undefined,
  })) as unknown as Array<ColumnDef>;
  td.constraints = [
    { kind: "PRIMARY_KEY", columns: [td.columns[0]!], implicit: undefined },
  ] as unknown as MutableTableDef["constraints"];
  return td as TableDef;
}

const fakeDriver = {
  typeName: (c: ColumnDef): string => (c.type.kind === "STR" ? "text" : "integer"),
} as unknown as SchemaDriver;

// ---- Postgres --------------------------------------------------------------

describe("PostgresDdlGenerator", () => {
  it("ADD/DROP COLUMN", () => {
    const d = diff([{
      kind: "ALTER_TABLE",
      table: "BOOK",
      columns: [
        { kind: "ADD_COLUMN", column: col("PRICE", "numeric(10,2)") },
        { kind: "DROP_COLUMN", column: "LEGACY" },
      ],
      constraints: [],
      indexes: [],
    }]);
    expect(new PostgresDdlGenerator().statements(d)).toEqual([
      'alter table "BOOK" add column "PRICE" numeric(10,2) not null',
      'alter table "BOOK" drop column "LEGACY"',
    ]);
  });

  it("ALTER COLUMN（类型 / nullable / 默认值）", () => {
    const d = diff([{
      kind: "ALTER_TABLE",
      table: "BOOK",
      columns: [
        {
          kind: "ALTER_COLUMN",
          column: "TITLE",
          type: "varchar(200)",
          nullable: true,
          default: "'untitled'",
          autoIncrement: undefined,
        },
        {
          kind: "ALTER_COLUMN",
          column: "AGE",
          type: undefined,
          nullable: false,
          default: "",
          autoIncrement: undefined,
        },
      ],
      constraints: [],
      indexes: [],
    }]);
    expect(new PostgresDdlGenerator().statements(d)).toEqual([
      'alter table "BOOK" alter column "TITLE" type varchar(200)',
      'alter table "BOOK" alter column "TITLE" drop not null',
      'alter table "BOOK" alter column "TITLE" set default \'untitled\'',
      'alter table "BOOK" alter column "AGE" set not null',
      'alter table "BOOK" alter column "AGE" drop default',
    ]);
  });

  it("ADD/DROP CONSTRAINT（FK 级联 / CHECK）", () => {
    const d = diff([{
      kind: "ALTER_TABLE",
      table: "BOOK",
      columns: [],
      constraints: [
        { kind: "ADD_CONSTRAINT", constraint: fk(["AUTHOR_ID"], "AUTHOR", ["ID"], "CASCADE") },
        { kind: "ADD_CONSTRAINT", constraint: ck("PRICE > 0") },
        { kind: "DROP_CONSTRAINT", constraint: { kind: "UNIQUE", name: "BOOK_uq_name", columns: ["NAME"], implicit: undefined } },
      ],
      indexes: [],
    }]);
    expect(new PostgresDdlGenerator().statements(d)).toEqual([
      'alter table "BOOK" add constraint "BOOK_fk_AUTHOR_ID" foreign key ("AUTHOR_ID") references "AUTHOR" ("ID") on delete cascade',
      'alter table "BOOK" add constraint "BOOK_ck_2" check (PRICE > 0)',
      'alter table "BOOK" drop constraint "BOOK_uq_name"',
    ]);
  });

  it("CREATE_TABLE / DROP_TABLE / 索引", () => {
    const book = table("BOOK", [col("ID", "integer"), col("TITLE", "text")], [pk(["ID"])]);
    const d = diff([
      { kind: "CREATE_TABLE", table: book },
      { kind: "DROP_TABLE", table: "OLD", foreignKeyNames: [] },
      {
        kind: "ALTER_TABLE",
        table: "BOOK",
        columns: [],
        constraints: [],
        indexes: [
          { kind: "ADD_INDEX", index: idx("BOOK_title_idx", ["TITLE"], true) },
          { kind: "DROP_INDEX", index: idx("OLD_idx", ["ID"]) },
        ],
      },
    ]);
    expect(new PostgresDdlGenerator().statements(d)).toEqual([
      'create table "BOOK" (\n  "ID" integer not null,\n  "TITLE" text not null,\n  constraint "BOOK_pk" primary key ("ID")\n)',
      'create unique index "BOOK_title_idx" on "BOOK" ("TITLE")',
      'drop index "OLD_idx"',
      // 删表统一排在最后（先摘外键、再删表，见下个用例）
      'drop table "OLD"',
    ]);
  });

  it("DROP_TABLE：先摘掉该表自己的外键，再删表", () => {
    const d = diff([
      { kind: "DROP_TABLE", table: "BOOK", foreignKeyNames: ["book_author_id_fkey"] },
    ]);

    expect(new PostgresDdlGenerator().statements(d)).toEqual([
      'alter table "BOOK" drop constraint "book_author_id_fkey"',
      'drop table "BOOK"',
    ]);
    // SQLite 没有 alter table ... drop constraint，删表时也不校验外键依赖
    expect(new SqliteDdlGenerator().statements(d)).toEqual(['drop table "BOOK"']);
  });

  it("DROP_TABLE（多表）：所有摘外键都排在所有删表之前", () => {
    // 字母序下一个被引用的表（book）会排在引用它的表（中间表）之前，
    // 若按表逐个「摘外键→删表」，book 会先被删而中间表的外键还没摘 → PG 拒绝。
    const d = diff([
      { kind: "DROP_TABLE", table: "book", foreignKeyNames: [] },
      { kind: "DROP_TABLE", table: "book_tag_mapping", foreignKeyNames: ["m_book_fk", "m_tag_fk"] },
      { kind: "DROP_TABLE", table: "tag", foreignKeyNames: [] },
    ]);

    expect(new PostgresDdlGenerator().statements(d)).toEqual([
      'alter table "book_tag_mapping" drop constraint "m_book_fk"',
      'alter table "book_tag_mapping" drop constraint "m_tag_fk"',
      'drop table "book"',
      'drop table "book_tag_mapping"',
      'drop table "tag"',
    ]);
  });

  it("CREATE_TABLE 自建且标识符带引号（PG 大小写保真）", () => {
    const author = table("AUTHOR", [col("ID", "integer"), col("NAME", "text")], [pk(["ID"])]);
    const d = diff([{ kind: "CREATE_TABLE", table: author }]);
    // PG 不用 ts-grm 原生 toCreationStatements：其表名不带引号会被 PG 折叠为小写，
    // 与目标态表名（AUTHOR）不一致导致 diff 误判；自建路径加引号保真
    expect(new PostgresDdlGenerator().statements(d)).toEqual([
      'create table "AUTHOR" (\n  "ID" integer not null,\n  "NAME" text not null,\n  constraint "AUTHOR_pk" primary key ("ID")\n)',
    ]);
  });

  it("createStatements 自建（无 TableDef）", () => {
    const s = schema([table("T1", [col("ID", "integer")], [pk(["ID"])])]);
    expect(new PostgresDdlGenerator().createStatements(s)).toEqual([
      'create table "T1" (\n  "ID" integer not null,\n  constraint "T1_pk" primary key ("ID")\n)',
    ]);
  });
});

// ---- SQLite ----------------------------------------------------------------

describe("SqliteDdlGenerator", () => {
  it("纯 ADD_COLUMN 原地执行", () => {
    const d = diff([{
      kind: "ALTER_TABLE",
      table: "BOOK",
      columns: [{ kind: "ADD_COLUMN", column: col("PRICE", "real", true) }],
      constraints: [],
      indexes: [],
    }]);
    expect(new SqliteDdlGenerator().statements(d)).toEqual([
      'alter table "BOOK" add column "PRICE" real null',
    ]);
  });

  it("DROP_COLUMN 触发重建表（复用原生建表 + 数据迁移 TODO）", () => {
    const td = makeTableDef("BOOK", [["ID", "I32", false], ["TITLE", "STR", false]]);
    const gen = new SqliteDdlGenerator({ driver: fakeDriver, tableDefs: new Map([["BOOK", td]]) });
    const d = diff([{
      kind: "ALTER_TABLE",
      table: "BOOK",
      columns: [{ kind: "DROP_COLUMN", column: "LEGACY" }],
      constraints: [],
      indexes: [],
    }]);
    const sql = gen.statements(d);
    expect(sql[0]).toContain("SQLite 重建表");
    expect(sql[1]).toBe('drop table if exists "BOOK"');
    expect(sql[2]).toContain("create table BOOK");
    expect(sql.join("\n")).toContain("数据迁移 TODO");
  });

  it("重建表缺少 TableDef 时抛错提示", () => {
    const gen = new SqliteDdlGenerator();
    const d = diff([{
      kind: "ALTER_TABLE",
      table: "BOOK",
      columns: [{
        kind: "ALTER_COLUMN",
        column: "TITLE",
        type: "text",
        nullable: undefined,
        default: undefined,
        autoIncrement: undefined,
      }],
      constraints: [],
      indexes: [],
    }]);
    expect(() => gen.statements(d)).toThrow(/重建表/);
  });

  it("索引变更独立执行，不触发重建", () => {
    const td = makeTableDef("BOOK", [["ID", "I32", false]]);
    const gen = new SqliteDdlGenerator({ driver: fakeDriver, tableDefs: new Map([["BOOK", td]]) });
    const d = diff([{
      kind: "ALTER_TABLE",
      table: "BOOK",
      columns: [],
      constraints: [],
      indexes: [{ kind: "ADD_INDEX", index: idx("BOOK_id_idx", ["ID"]) }],
    }]);
    expect(gen.statements(d)).toEqual([
      'create index "BOOK_id_idx" on "BOOK" ("ID")',
    ]);
  });
});
