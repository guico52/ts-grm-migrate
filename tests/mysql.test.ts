import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import mysql from "mysql2/promise";
import { createRuntime } from "../src/runtime";

const enabled = process.env.MYSQL_HOST != null;
const run = enabled ? describe : describe.skip;
run.sequential("MySQL 端到端迁移", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "tgm-mysql-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it("dev 建表、重复运行幂等、失败历史可恢复", async () => {
    const config = {
      dialect: "mysql" as const,
      database: { host: process.env.MYSQL_HOST!, port: Number(process.env.MYSQL_PORT ?? 3306), user: "root", password: process.env.MYSQL_PASSWORD ?? "tgm-test-only", database: process.env.MYSQL_DATABASE ?? "tgmtest" },
      models: ["./tests/model/model.ts"], migrationsDir: path.join(dir, "migrations"), lockPath: path.join(dir, "lock"),
    };
    const admin = await mysql.createConnection({ host: config.database.host, port: config.database.port, user: config.database.user, password: config.database.password });
    await admin.query(`drop database if exists ${config.database.database}`);
    await admin.query(`create database ${config.database.database}`);
    await admin.end();
    const runtime = await createRuntime(config, path.resolve("."));
    try {
      const first = await runtime.migrator.dev({ name: "init" });
      expect(first.applied).toBe(true);
      expect(first.drift).toEqual([]);
      const second = await runtime.migrator.dev({});
      expect(second.applied).toBe(false);
      expect(second.diff.changes).toEqual([]);
      const rows = await runtime.migrator.status();
      expect(rows.applied).toHaveLength(1);
    } finally { await runtime.close(); }
  });
});
