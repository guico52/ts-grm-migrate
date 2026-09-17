import { describe, it, expect } from "vitest";
import {
  ScalarType,
  type ColumnDef,
  type ConstraintDef,
  type TableDef,
} from "../src/vendor/ts-grm";
import { tableDefsToSchema, type SchemaDriver } from "../src";
import { toSnapshot, fromSnapshot, isSchema } from "../src";

/** 构造期可变形态（TableDef.columns/constraints 是 readonly，构造时先填充） */
type MutableTableDef = TableDef & {
  columns: Array<ColumnDef>;
  constraints: Array<ConstraintDef>;
};

function makeTable(name: string): MutableTableDef {
  return {
    entity: undefined,
    prop: undefined,
    name,
    columns: [],
    constraints: [],
    toCreationStatements: () => [],
    toDeletionStatements: () => [],
  } as unknown as MutableTableDef;
}

function makeColumn(
  declaringTable: TableDef,
  name: string,
  type: ColumnDef["type"],
  nullable: boolean,
): ColumnDef {
  return {
    declaringTable,
    prop: undefined,
    name,
    type,
    nullable,
    length: type.length,
    when: undefined,
  } as unknown as ColumnDef;
}

/** 手工构造 TableDef（纯数据 + 方法 stub），模拟 createSchema 产物的形状 */
function buildTableDefs(): ReadonlyArray<TableDef> {
  const author = makeTable("author");
  const authorId = makeColumn(author, "id", ScalarType.I32, false);
  const authorName = makeColumn(author, "name", ScalarType.str(50), false);
  author.columns = [authorId, authorName];
  author.constraints = [
    { kind: "PRIMARY_KEY", columns: [authorId], implicit: undefined },
    { kind: "UNIQUE", columns: [authorName], implicit: undefined },
  ];

  const book = makeTable("book");
  const bookId = makeColumn(book, "id", ScalarType.I32, false);
  const authorIdFk = makeColumn(book, "author_id", ScalarType.I32, true);
  const bookType = makeColumn(book, "type", ScalarType.str(10), false);
  book.columns = [bookId, authorIdFk, bookType];
  book.constraints = [
    { kind: "PRIMARY_KEY", columns: [bookId], implicit: undefined },
    {
      kind: "FOREIGN_KEY",
      columns: [authorIdFk],
      referencedColumns: [authorId],
      cascade: "SET_NULL",
      implicit: undefined,
    },
    {
      kind: "CHECK",
      column: bookType,
      values: ["NOVEL", "TEXTBOOK"],
      implicit: undefined,
    },
  ];

  return [author, book];
}

/** fake 方言映射（模拟 ts-grm driver.typeName 的行为） */
const fakeDriver = {
  typeName: (columnDef: ColumnDef): string => {
    switch (columnDef.type.kind) {
      case "I32":
        return "integer";
      case "STR":
        return columnDef.length != null ? `varchar(${columnDef.length})` : "text";
      default:
        throw new Error(`unsupported: ${columnDef.type.kind}`);
    }
  },
} as unknown as SchemaDriver;

describe("适配器 tableDefsToSchema", () => {
  const schema = tableDefsToSchema(buildTableDefs(), fakeDriver);

  it("表名去引号、列字段搬运", () => {
    expect(schema.tables.map((t) => t.name)).toEqual(["author", "book"]);
    const author = schema.tables[0]!;
    expect(author.columns[0]).toMatchObject({
      name: "id",
      type: "integer",
      nullable: false,
      ordinal: 1,
      autoIncrement: false,
      default: undefined,
    });
    expect(author.columns[1]!.type).toBe("varchar(50)");
    expect(author.indexes).toEqual([]);
  });

  it("约束映射：PK/UNIQUE/FK/CHECK", () => {
    const book = schema.tables[1]!;
    const pk = book.constraints.find((c) => c.kind === "PRIMARY_KEY")!;
    expect(pk.columns).toEqual(["id"]);

    const fk = book.constraints.find((c) => c.kind === "FOREIGN_KEY")!;
    expect(fk).toMatchObject({
      columns: ["author_id"],
      referencedTable: "author",
      referencedColumns: ["id"],
      onDelete: "SET_NULL",
      deferrable: false,
      cascade: "SET_NULL",
    });

    const check = book.constraints.find((c) => c.kind === "CHECK")!;
    expect(check.expression).toBe("type in ('NOVEL', 'TEXTBOOK')");
  });
});

describe("快照序列化", () => {
  it("toSnapshot → fromSnapshot 往返等价", () => {
    const schema = tableDefsToSchema(buildTableDefs(), fakeDriver);
    const json = toSnapshot(schema);
    const restored = fromSnapshot(json);
    expect(restored).toEqual(schema);
  });

  it("快照包含格式版本号", () => {
    const json = toSnapshot(tableDefsToSchema(buildTableDefs(), fakeDriver));
    const parsed = JSON.parse(json) as { formatVersion?: number; schema?: unknown };
    expect(parsed.formatVersion).toBe(1);
    expect(isSchema(parsed.schema)).toBe(true);
  });
});

describe("快照校验（外部输入安全）", () => {
  it("非法 JSON 抛错", () => {
    expect(() => fromSnapshot("not json{{{")).toThrow(/不是合法 JSON/);
  });

  it("版本不兼容抛错", () => {
    expect(() => fromSnapshot('{"formatVersion": 99, "schema": {}}')).toThrow(
      /格式版本不兼容/,
    );
  });

  it("形状损坏被拒绝", () => {
    expect(() => fromSnapshot('{"formatVersion": 1, "schema": {"tables": [{"name": 42}]}}')).toThrow(
      /快照格式不合法/,
    );
  });

  it("约束 kind 非法被拒绝", () => {
    const bad = '{"formatVersion":1,"schema":{"tables":[{"name":"t","columns":[],"constraints":[{"kind":"INDEX"}],"indexes":[]}]}}';
    expect(() => fromSnapshot(bad)).toThrow(/快照格式不合法/);
  });
});
