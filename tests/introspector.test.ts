import { describe, it, expect } from "vitest";
import { PostgresIntrospector, normalizeType } from "../src/introspector/postgres";
import type { SqlQueryable } from "../src/introspector";
import type { Schema } from "../src/schema/model";

/**
 * 注入式单元测试：不连数据库，直接喂 pg_catalog 样式的行。
 * 覆盖 SQL 结果 → Schema 的组装、类型归一化、约束映射与错误包装。
 */

interface FakeData {
  readonly tables?: ReadonlyArray<Record<string, unknown>>;
  readonly columns?: ReadonlyArray<Record<string, unknown>>;
  readonly constraints?: ReadonlyArray<Record<string, unknown>>;
  readonly indexes?: ReadonlyArray<Record<string, unknown>>;
}

/** 按 SQL 特征片段分派（不匹配语句全文，语句微调不会破坏测试） */
function fakeQuery(data: FakeData): SqlQueryable {
  return {
    async query(sql: string) {
      // 判定顺序要紧：INDEXES_SQL 内含 "from pg_constraint" 子查询（排除约束背后的索引），
      // 必须先按 "from pg_index" 判定
      if (sql.includes("from pg_attribute")) return { rows: data.columns ?? [] };
      if (sql.includes("from pg_index")) return { rows: data.indexes ?? [] };
      if (sql.includes("from pg_constraint")) return { rows: data.constraints ?? [] };
      if (sql.includes("from pg_class")) return { rows: data.tables ?? [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

function introspect(data: FakeData, schema?: string): Promise<Schema> {
  return new PostgresIntrospector({ query: fakeQuery(data), schema }).introspect();
}

describe("PostgresIntrospector：组装", () => {
  it("空库产出空 schema", async () => {
    const schema = await introspect({});
    expect(schema.tables).toEqual([]);
  });

  it("表按 pg_class 顺序产出，列挂到对应表下", async () => {
    const schema = await introspect({
      tables: [{ name: "AUTHOR" }, { name: "BOOK" }],
      columns: [
        { table_name: "AUTHOR", name: "ID", type: "bigint", nullable: false, ordinal: 1 },
        { table_name: "AUTHOR", name: "NAME", type: "text", nullable: true, ordinal: 2 },
        { table_name: "BOOK", name: "ID", type: "bigint", nullable: false, ordinal: 1 },
      ],
    });
    expect(schema.tables.map((t) => t.name)).toEqual(["AUTHOR", "BOOK"]);
    expect(schema.tables[0]!.columns.map((c) => c.name)).toEqual(["ID", "NAME"]);
    expect(schema.tables[0]!.columns[1]!.nullable).toBe(true);
    expect(schema.tables[1]!.columns.map((c) => c.name)).toEqual(["ID"]);
  });

  it("无列的孤儿表也产出（columns 为空数组）", async () => {
    const schema = await introspect({ tables: [{ name: "EMPTY" }] });
    expect(schema.tables[0]!.columns).toEqual([]);
    expect(schema.tables[0]!.constraints).toEqual([]);
    expect(schema.tables[0]!.indexes).toEqual([]);
  });

  it("列字段：default / comment / ordinal 原样搬运，缺失为 undefined", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      columns: [
        {
          table_name: "T",
          name: "A",
          type: "text",
          nullable: true,
          ordinal: 3,
          default_expr: "'x'::text",
          comment: "说明",
        },
        { table_name: "T", name: "B", type: "text", nullable: true, ordinal: 4 },
      ],
    });
    const [a, b] = schema.tables[0]!.columns;
    expect(a!.default).toBe("'x'::text");
    expect(a!.comment).toBe("说明");
    expect(a!.ordinal).toBe(3);
    expect(b!.default).toBeUndefined();
    expect(b!.comment).toBeUndefined();
  });

  it("列上的 CHECK / 未知约束类型被跳过，不影响其他约束", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      constraints: [
        { table_name: "T", name: "pk", kind: "p", columns: ["ID"] },
        { table_name: "T", name: "excl", kind: "x", columns: ["ID"] },
      ],
    });
    expect(schema.tables[0]!.constraints.map((c) => c.kind)).toEqual(["PRIMARY_KEY"]);
  });
});

describe("PostgresIntrospector：自增识别", () => {
  it("identity 列（attidentity = a / d）算自增", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      columns: [
        { table_name: "T", name: "A", type: "bigint", nullable: false, ordinal: 1, identity: "a" },
        { table_name: "T", name: "B", type: "bigint", nullable: false, ordinal: 2, identity: "d" },
      ],
    });
    expect(schema.tables[0]!.columns.map((c) => c.autoIncrement)).toEqual([true, true]);
  });

  it("serial 列（默认值 nextval）算自增", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      columns: [
        {
          table_name: "T",
          name: "ID",
          type: "integer",
          nullable: false,
          ordinal: 1,
          default_expr: "nextval('t_id_seq'::regclass)",
          identity: "",
        },
      ],
    });
    expect(schema.tables[0]!.columns[0]!.autoIncrement).toBe(true);
  });

  it("普通默认值不算自增", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      columns: [
        {
          table_name: "T",
          name: "A",
          type: "integer",
          nullable: true,
          ordinal: 1,
          default_expr: "0",
          identity: "",
        },
      ],
    });
    expect(schema.tables[0]!.columns[0]!.autoIncrement).toBe(false);
  });
});

describe("PostgresIntrospector：约束", () => {
  it("主键 / 唯一约束：带真实约束名（DROP 需要）", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      constraints: [
        { table_name: "T", name: "T_constraint_1", kind: "p", columns: ["ID"] },
        { table_name: "T", name: "T_constraint_2", kind: "u", columns: ["A", "B"] },
      ],
    });
    expect(schema.tables[0]!.constraints).toEqual([
      { kind: "PRIMARY_KEY", name: "T_constraint_1", columns: ["ID"], implicit: undefined },
      { kind: "UNIQUE", name: "T_constraint_2", columns: ["A", "B"], implicit: undefined },
    ]);
  });

  it("外键：引用表/列、ON DELETE 映射、deferrable、cascade 反推", async () => {
    const schema = await introspect({
      tables: [{ name: "BOOK" }],
      constraints: [
        {
          table_name: "BOOK",
          name: "BOOK_constraint_2",
          kind: "f",
          columns: ["AUTHOR_ID"],
          referenced_table: "AUTHOR",
          referenced_columns: ["ID"],
          delete_action: "c",
          deferrable: true,
        },
      ],
    });
    expect(schema.tables[0]!.constraints[0]).toEqual({
      kind: "FOREIGN_KEY",
      name: "BOOK_constraint_2",
      columns: ["AUTHOR_ID"],
      referencedTable: "AUTHOR",
      referencedColumns: ["ID"],
      onDelete: "CASCADE",
      deferrable: true,
      cascade: "DELETE",
      implicit: undefined,
    });
  });

  it("外键：无动作 / SET NULL / SET DEFAULT / RESTRICT 的映射", async () => {
    const codes: ReadonlyArray<[string, string]> = [
      ["a", "NO_ACTION"],
      ["r", "RESTRICT"],
      ["n", "SET_NULL"],
      ["d", "SET_DEFAULT"],
    ];
    for (const [code, expected] of codes) {
      const schema = await introspect({
        tables: [{ name: "T" }],
        constraints: [
          {
            table_name: "T",
            name: "fk",
            kind: "f",
            columns: ["X"],
            referenced_table: "R",
            referenced_columns: ["Y"],
            delete_action: code,
            deferrable: false,
          },
        ],
      });
      const fk = schema.tables[0]!.constraints[0];
      expect(fk != null && fk.kind === "FOREIGN_KEY" ? fk.onDelete : null).toBe(expected);
    }
  });

  it("CHECK：剥掉 CHECK 前缀与最外层括号", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      constraints: [
        {
          table_name: "T",
          name: "T_constraint_3",
          kind: "c",
          definition: "CHECK ((TYPE = ANY (ARRAY['Book'::text])))",
        },
      ],
    });
    expect(schema.tables[0]!.constraints[0]).toEqual({
      kind: "CHECK",
      name: "T_constraint_3",
      values: [],
      expression: "(TYPE = ANY (ARRAY['Book'::text]))",
      implicit: undefined,
    });
  });
});

describe("asStringArray：pg 数组解析的边界", () => {
  it("兼容 pg 原样返回的 PG 数组字面量字符串（name[] 未被解析）", async () => {
    // 实测：array_agg(attname) 的类型是 name[]，pg 不解析、原样返回 "{ID}"。
    // SQL 已用 ::text 规避；这里覆盖兜底解析。
    const schema = await introspect({
      tables: [{ name: "T" }],
      constraints: [
        { table_name: "T", name: "pk", kind: "p", columns: "{ID}" },
        { table_name: "T", name: "uq", kind: "u", columns: '{"a b",c}' },
      ],
    });
    expect(schema.tables[0]!.constraints[0]).toEqual({
      kind: "PRIMARY_KEY",
      name: "pk",
      columns: ["ID"],
      implicit: undefined,
    });
    expect(schema.tables[0]!.constraints[1]).toEqual({
      kind: "UNIQUE",
      name: "uq",
      columns: ["a b", "c"],
      implicit: undefined,
    });
  });

  it("空数组字面量 {} → []", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      constraints: [{ table_name: "T", name: "pk", kind: "p", columns: "{}" }],
    });
    expect(schema.tables[0]!.constraints[0]).toMatchObject({ columns: [] });
  });
});

describe("PostgresIntrospector：索引", () => {
  it("独立索引：唯一性、列、部分索引谓词", async () => {
    const schema = await introspect({
      tables: [{ name: "T" }],
      indexes: [
        { table_name: "T", name: "T_NAME_IDX", is_unique: false, columns: ["NAME"] },
        {
          table_name: "T",
          name: "T_ACTIVE_UQ",
          is_unique: true,
          columns: ["NAME"],
          predicate: "(ACTIVE = true)",
        },
      ],
    });
    expect(schema.tables[0]!.indexes).toEqual([
      { name: "T_NAME_IDX", columns: ["NAME"], unique: false, predicate: undefined },
      { name: "T_ACTIVE_UQ", columns: ["NAME"], unique: true, predicate: "(ACTIVE = true)" },
    ]);
  });
});

describe("PostgresIntrospector：错误处理", () => {
  it("查询失败包成带 schema 名的可读错误", async () => {
    const failing: SqlQueryable = {
      async query() {
        throw new Error("connection refused");
      },
    };
    const introspector = new PostgresIntrospector({ query: failing, schema: "app" });
    await expect(introspector.introspect()).rejects.toThrow(
      /Postgres 结构读取失败（schema "app"）：connection refused/,
    );
  });

  it("默认 schema 为 public", async () => {
    let seen: ReadonlyArray<unknown> | undefined;
    const spy: SqlQueryable = {
      async query(_sql: string, params?: ReadonlyArray<unknown>) {
        seen = params;
        return { rows: [] };
      },
    };
    await new PostgresIntrospector({ query: spy }).introspect();
    expect(seen).toEqual(["public"]);
  });
});

describe("normalizeType：与 ts-grm PostgresDriver.typeName 对齐", () => {
  it("timestamp with time zone → timestamptz", () => {
    expect(normalizeType("timestamp with time zone")).toBe("timestamptz");
  });

  it("numeric 补逗号后的空格", () => {
    expect(normalizeType("numeric(10,2)")).toBe("numeric(10, 2)");
    expect(normalizeType("numeric(20,0)")).toBe("numeric(20, 0)");
  });

  it("其余类型原样保留", () => {
    expect(normalizeType("bigint")).toBe("bigint");
    expect(normalizeType("text")).toBe("text");
    expect(normalizeType("double precision")).toBe("double precision");
    expect(normalizeType("character varying(50)")).toBe("character varying(50)");
    expect(normalizeType("timestamp without time zone")).toBe("timestamp without time zone");
  });

  it("ts-grm 的 typeName 全部输出经归一化保持不变（幂等）", () => {
    // 来源：packages/sql/src/driver/postgres_driver.ts:293-324 的完整分支
    const tsGrmOutputs = [
      "text", // STR / TEXT
      "boolean", // BOOL
      "smallint", // I8 / I16
      "integer", // I32
      "bigint", // I64
      "real", // F32
      "double precision", // F64
      "numeric(10, 2)", // NUM —— 逗号后有空格
      "timestamptz", // DATETIME
      "bytea", // BINARY
      "json", // JSON
      "jsonb", // JSONB
    ];
    for (const type of tsGrmOutputs) {
      expect(normalizeType(type), `归一化误改了 ts-grm 的输出: ${type}`).toBe(type);
    }
  });
});
