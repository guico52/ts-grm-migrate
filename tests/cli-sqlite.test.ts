/**
 * CLI 端到端测试（SQLite）—— 不需要任何外部服务。
 *
 * 模拟「用户项目」：临时目录放配置与迁移目录，`models` 指向本仓库的测试模型，
 * 然后真的调用 `run()` 走完 dev / status / deploy / push。
 * 每一轮都用一个新的库文件（`:memory:` 不行 —— 每次装配都会开一个新内存库）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { run } from "../src/cli";

/** 模型相对 CWD 解析，因此 CWD 固定为仓库根 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI 端到端（SQLite）", () => {
  let dir: string;
  let dbFile: string;
  let configPath: string;
  const logs: Array<string> = [];
  const errors: Array<string> = [];

  const runCli = (argv: ReadonlyArray<string>): Promise<number> =>
    run(argv, REPO_ROOT, {
      log: (m) => logs.push(m),
      errorLog: (m) => errors.push(m),
    });

  const writeConfig = async (language?: "en" | "zh-CN"): Promise<void> => {
    await writeFile(
      configPath,
      `export default ${JSON.stringify(
        {
          dialect: "sqlite",
          ...(language != null ? { language } : {}),
          database: { file: dbFile },
          models: ["./tests/model/model.ts"],
          migrationsDir: path.join(dir, "migrations"),
          lockPath: path.join(dir, "migrate.lock"),
        },
        null,
        2,
      )};\n`,
      "utf8",
    );
  };

  /** 直连库文件看真实结构（绕过 migrate，独立验证） */
  const tables = (): Array<string> => {
    const db = new Database(dbFile);
    try {
      const rows = db
        .prepare(
          `select name from sqlite_master
           where type = 'table' and name not like 'sqlite_%' and name <> '_migrations'
           order by name`,
        )
        .all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    logs.length = 0;
    errors.length = 0;
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-sqlite-e2e-"));
    dbFile = path.join(dir, "app.db");
    configPath = path.join(dir, "ts-grm-migrate.config.ts");
    await writeConfig();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dev：生成并应用迁移，表真的建出来", async () => {
    const code = await runCli(["dev", "-n", "init", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/Generated and applied migration \d{17}_init/);
    expect(logs).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("Executing SQL");
    expect(tables()).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);
  });

  it("dev 幂等：模型没变时不产生新迁移", async () => {
    await runCli(["dev", "--config", configPath]);
    logs.length = 0;

    const code = await runCli(["dev", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("is up to date; no migration needed.");
  });

  it("create-only writes a pending file without applying SQL or creating history", async () => {
    expect(await runCli(["dev", "--create-only", "-n", "review", "--config", configPath])).toBe(0);
    expect(logs.join("\n")).toContain("Generated migration");
    expect(tables()).toEqual([]);
    const db = new Database(dbFile);
    expect(db.prepare("select name from sqlite_master where name='_migrations'").all()).toEqual([]);
    db.close();
    const migrations = path.join(dir, "migrations");
    const files = await readdir(migrations);
    expect(files).toHaveLength(1);
    await appendFile(path.join(migrations, files[0]!), '\ncreate index "reviewed_index" on "AUTHOR" ("ID");\n');
    await expect(runCli(["dev", "--config", configPath])).rejects.toThrow(/Pending migrations/);
    expect(await runCli(["deploy", "--config", configPath])).toBe(0);
    expect(tables()).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);
    expect(await runCli(["check", "--config", configPath])).toBe(0);
    const applied = new Database(dbFile);
    try { expect(applied.prepare("select name from sqlite_master where name='reviewed_index'").all()).toHaveLength(1); }
    finally { applied.close(); }
  });

  it("check reports drift without writing; independent unique indexes survive push", async () => {
    await runCli(["dev", "--config", configPath]);
    const db = new Database(dbFile);
    try {
      const history = db.prepare("select * from _migrations").all();
      db.exec('create unique index "manual_unique" on "AUTHOR" ("ID"); alter table "AUTHOR" add column "LEGACY" text');
      expect(await runCli(["check", "--config", configPath])).toBe(1);
      expect(errors.join("\n")).toContain("LEGACY");
      expect(db.prepare('pragma table_info("AUTHOR")').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "LEGACY" })]));
      expect(db.prepare("select * from _migrations").all()).toEqual(history);
      db.exec('alter table "AUTHOR" drop column "LEGACY"');
      expect(await runCli(["check", "--config", configPath])).toBe(0);
      expect(await runCli(["push", "--config", configPath])).toBe(0);
      expect(db.prepare("select name from sqlite_master where name='manual_unique'").all()).toHaveLength(1);
    } finally { db.close(); }
  });

  it("check does not create a missing SQLite file", async () => {
    await expect(runCli(["check", "--config", configPath])).rejects.toThrow(/unable to open database/);
    expect(await readdir(dir)).toEqual(["ts-grm-migrate.config.ts"]);
  });

  it("status：汇报已应用与待应用", async () => {
    await runCli(["dev", "--config", configPath]);
    logs.length = 0;

    const code = await runCli(["status", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/Applied:/);
  });

  it("deploy：从空库按序应用迁移", async () => {
    // 先在一个库里生成迁移文件，再用新的空库 deploy
    await runCli(["dev", "--config", configPath]);
    await rm(dbFile, { force: true });
    logs.length = 0;

    const code = await runCli(["deploy", "--config", configPath]);

    expect(code).toBe(0);
    expect(tables()).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);
  });

  it("push：直接同步，不写迁移文件", async () => {
    const code = await runCli(["push", "--config", configPath]);

    expect(code).toBe(0);
    expect(tables()).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);
  });

  it("--detail 显示 SQL 和锁信息，--lang zh-CN 显示中文结果", async () => {
    const code = await runCli(["dev", "--detail", "--lang", "zh-CN", "--config", configPath]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("执行 SQL:");
    expect(logs.join("\n")).toContain("已获取进程锁");
    expect(logs.join("\n")).toContain("已获取数据库锁");
    expect(logs.join("\n")).toContain("已在 sqlite");
  });

  it("配置语言作为项目默认值，--lang 只覆盖本次命令", async () => {
    await writeConfig("zh-CN");
    expect(await runCli(["dev", "--config", configPath])).toBe(0);
    expect(logs.join("\n")).toContain("已在 sqlite");

    logs.length = 0;
    expect(await runCli(["status", "--config", configPath])).toBe(0);
    expect(logs.join("\n")).toContain("已应用：");

    logs.length = 0;
    expect(await runCli(["status", "--lang", "en", "--config", configPath])).toBe(0);
    expect(logs.join("\n")).toContain("Applied:");

    logs.length = 0;
    expect(await runCli(["--help", "--config", configPath])).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
  });
});
