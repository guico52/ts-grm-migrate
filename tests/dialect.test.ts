import { describe, it, expect } from "vitest";
import {
  DIALECTS,
  DIALECT_NAMES,
  IMPLEMENTED_DIALECT_NAMES,
  dialectInfo,
} from "../src/dialect";
import { createRuntime } from "../src/runtime";
import { defineConfig } from "../src/config";

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

  it("目前只有 postgres 端到端可用", () => {
    expect(IMPLEMENTED_DIALECT_NAMES).toEqual(["postgres"]);
    expect(DIALECTS.filter((d) => d.implemented).map((d) => d.name)).toEqual(["postgres"]);
  });

  it("sqlite 有 DDL 生成器，但端到端仍未实现", () => {
    const info = dialectInfo("sqlite");
    expect(info.implemented).toBe(false);
    expect(info.tsGrmDrivers).toEqual(["SqliteDriver"]);
  });

  it("未知方言报错并列出已知方言", () => {
    expect(() => dialectInfo("db2")).toThrow(/未知方言 "db2".*postgres \/ mysql/s);
  });
});

describe("未实现方言在装配前被拒止", () => {
  it("mysql：报错指明上游驱动名与已实现方言", async () => {
    const config = defineConfig({ database: {}, models: ["./x"], dialect: "mysql" });
    await expect(createRuntime(config, process.cwd())).rejects.toThrow(
      /方言 "mysql" 尚未实现（ts-grm 侧由 MySqlDriver 提供）。目前端到端可用的方言：postgres/,
    );
  });

  it("mssql：提示带上全部版本变体", async () => {
    const config = defineConfig({ database: {}, models: ["./x"], dialect: "mssql" });
    await expect(createRuntime(config, process.cwd())).rejects.toThrow(
      /SqlServerDriver \/ SqlServer2012Driver/,
    );
  });

  it("未知方言由注册表拦下", async () => {
    const config = { database: {}, models: ["./x"], dialect: "db2" } as never;
    await expect(createRuntime(config, process.cwd())).rejects.toThrow(/未知方言 "db2"/);
  });
});
