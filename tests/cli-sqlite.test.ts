/**
 * CLI 端到端测试（SQLite）—— 不需要任何外部服务。
 *
 * 模拟「用户项目」：临时目录放配置与迁移目录，`models` 指向本仓库的测试模型，
 * 然后真的调用 `run()` 走完 dev / status / deploy / push。
 * 每一轮都用一个新的库文件（`:memory:` 不行 —— 每次装配都会开一个新内存库）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await writeFile(
      configPath,
      `export default ${JSON.stringify(
        {
          dialect: "sqlite",
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
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dev：生成并应用迁移，表真的建出来", async () => {
    const code = await runCli(["dev", "-n", "init", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/已生成并应用迁移：\d{17}_init/);
    expect(tables()).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);
  });

  it("dev 幂等：模型没变时不产生新迁移", async () => {
    await runCli(["dev", "--config", configPath]);
    logs.length = 0;

    const code = await runCli(["dev", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("模型与数据库结构一致，无需迁移。");
  });

  it("status：汇报已应用与待应用", async () => {
    await runCli(["dev", "--config", configPath]);
    logs.length = 0;

    const code = await runCli(["status", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/已应用/);
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
});
