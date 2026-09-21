import { describe, it, expect } from "vitest";
import {
  DIALECTS,
  DIALECT_NAMES,
  IMPLEMENTED_DIALECT_NAMES,
  dialectInfo,
} from "../src/dialect";
import { createRuntime } from "../src/runtime";

describe("方言注册表", () => {
  it("覆盖 ts-grm 的全部驱动型号", () => {
    // 上游 @ts-grm/sql 导出 7 个驱动，注册表里必须都有归属
    expect(DIALECTS.flatMap((d) => d.tsGrmDrivers)).toEqual([
      "PostgresDriver",
      "MySqlDriver",
      "SqliteDriver",
      "SqlServerDriver",
      "SqlServer2012Driver",
      "OracleDriver",
      "Oracle12Drivier",
    ]);
  });

  it("方言名齐全（含 mssql / oracle 的版本变体归并）", () => {
    expect(DIALECT_NAMES).toEqual(["postgres", "mysql", "sqlite", "mssql", "oracle"]);
    expect(dialectInfo("mssql").tsGrmDrivers).toEqual(["SqlServerDriver", "SqlServer2012Driver"]);
    expect(dialectInfo("oracle").tsGrmDrivers).toEqual(["OracleDriver", "Oracle12Drivier"]);
  });

  it("五种方言均已接通", () => {
    expect(IMPLEMENTED_DIALECT_NAMES).toEqual(DIALECT_NAMES);
    expect(DIALECTS.filter((d) => d.implemented).map((d) => d.name)).toEqual([
      "postgres",
      "mysql",
      "sqlite",
      "mssql",
      "oracle",
    ]);
    // 未实现的方言仍要能报出上游驱动名
    expect(dialectInfo("sqlite").tsGrmDrivers).toEqual(["SqliteDriver"]);
    expect(dialectInfo("mysql").implemented).toBe(true);
  });

  it("未知方言报错并列出已知方言", () => {
    expect(() => dialectInfo("db2")).toThrow(/未知方言 "db2".*postgres \/ mysql/s);
  });
});

describe("运行时方言校验", () => {
  it("未知方言由注册表拦下", async () => {
    const config = { database: {}, models: ["./x"], dialect: "db2" } as never;
    await expect(createRuntime(config, process.cwd())).rejects.toThrow(/未知方言 "db2"/);
  });
});
