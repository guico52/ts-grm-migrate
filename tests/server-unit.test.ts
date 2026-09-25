import { describe, expect, it } from "vitest";
import { splitOracleSql, OracleSqlExecutor } from "../src/executor/oracle";
import { ServerSql, normalizeServerType } from "../src/server/sql";
import { normalizeServerExpression } from "../src/server/catalog";
import { SchemaDiffer } from "../src/differ";
import type { Schema } from "../src/schema/model";

describe("Oracle SQL 文件边界", () => {
  it("字符串、q-quote、注释中的分号不切分语句", () => {
    expect(
      splitOracleSql(
        `-- header ;\ninsert into "semi;colon" values ('it''s;ok', q'[a;'b]'); /* comment ; */ select 1 from dual;`,
      ),
    ).toEqual([
      `insert into "semi;colon" values ('it''s;ok', q'[a;'b]')`,
      "select 1 from dual",
    ]);
  });
  it("执行之前拒绝 PL/SQL 或不完整文件，保证前半段不会执行", async () => {
    const calls: string[] = [];
    const executor = new OracleSqlExecutor(
      {
        execute: async (sql) => {
          calls.push(sql);
          return {};
        },
      },
      "TEST",
    );
    await expect(
      executor.executeStatements([
        "create table A (ID number); begin null; end;",
      ]),
    ).rejects.toThrow(/PL\/SQL/);
    await expect(
      executor.executeStatements(["create table A (ID number); select 'bad"]),
    ).rejects.toThrow(/unterminated/);
    expect(calls).toEqual([]);
  });
  it("Oracle :n 按名称绑定，出现顺序不会错配", async () => {
    let captured: Record<string, unknown> = {};
    const executor = new OracleSqlExecutor(
      {
        execute: async (_sql, binds) => {
          captured = binds;
          return {};
        },
      },
      "TEST",
    );
    await executor.query("update T set VALUE=:2 where ID=:1", ["id", "value"]);
    expect(captured).toEqual({ "1": "id", "2": "value" });
  });
});

describe("方言共享结构", () => {
  it("schema 与表名分别引用，转义标识符中括号/引号", () => {
    expect(new ServerSql("mssql", "a]b").table("c]d")).toBe("[a]]b].[c]]d]");
    expect(new ServerSql("oracle", 'a"b').table('c"d')).toBe('"a""b"."c""d"');
    expect(
      Buffer.byteLength(new ServerSql("oracle", "x").name("名称".repeat(100))),
    ).toBeLessThanOrEqual(128);
  });
  it("decimal 和 timestamp 默认精度归一化", () => {
    expect(normalizeServerType("NUMBER(19, 0)", "oracle")).toBe("number(19)");
    expect(normalizeServerType("TIMESTAMP(6)", "oracle")).toBe("timestamp");
    expect(normalizeServerType("decimal(12, 3)", "mssql")).toBe(
      "decimal(12,3)",
    );
    expect(normalizeServerExpression("([AGE]>=(0))")).toBe(
      normalizeServerExpression("AGE >= 0"),
    );
    expect(normalizeServerExpression("VALUE = 'a ( b )'")).not.toBe(
      normalizeServerExpression("VALUE = 'a b'"),
    );
  });
  it("已不存在的默认值不会重复生成 DROP DEFAULT", () => {
    const from: Schema = {
      tables: [
        {
          name: "T",
          columns: [
            {
              name: "ID",
              type: "int",
              nullable: true,
              default: undefined,
              ordinal: 1,
              autoIncrement: false,
              length: undefined,
              comment: undefined,
            },
          ],
          constraints: [],
          indexes: [],
        },
      ],
    };
    const to = {
      tables: from.tables.map((t) => ({
        ...t,
        columns: t.columns.map((c) => ({ ...c, default: "" })),
      })),
    };
    expect(new SchemaDiffer().diff(from, to).changes).toEqual([]);
  });
});
