/**
 * CLI 端到端测试 —— **需要真实数据库**，无 PG_HOST 时整体跳过。
 *
 * 模拟「用户项目」：临时目录放配置与迁移目录，`models` 指向本仓库的测试模型，
 * 然后真的调用 `run()` 走完 dev / status / deploy / push。
 *
 * 运行：`PG_HOST=... PG_PASSWORD=... yarn vitest run tests/cli-postgres.test.ts`
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { run } from "../src/cli";

const PG_HOST = process.env.PG_HOST;
const PG_CONFIG = {
  host: PG_HOST ?? "",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "ts_grm_migrate_test",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "",
};

const TEST_SCHEMA = "cli_e2e";
/** 模型相对 CWD 解析，因此 CWD 固定为仓库根 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const describePg = PG_HOST != null ? describe.sequential : describe.skip;

describePg("CLI 端到端（真实数据库）", () => {
  const pool = new Pool({ ...PG_CONFIG, max: 2 });
  let dir: string;
  let configPath: string;
  const logs: Array<string> = [];
  const errors: Array<string> = [];

  // 不注入 confirm：让 CLI 走真实逻辑（测试环境非 TTY，破坏性变更会被拒绝）
  const runCli = (argv: ReadonlyArray<string>): Promise<number> =>
    run(argv, REPO_ROOT, {
      log: (m) => logs.push(m),
      errorLog: (m) => errors.push(m),
    });

  beforeAll(async () => {
    await cleanupSchema();
  });

  afterAll(async () => {
    await cleanupSchema();
    await pool.end();
  });

  beforeEach(async () => {
    logs.length = 0;
    errors.length = 0;
    await cleanupSchema();
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-cli-e2e-"));
    configPath = path.join(dir, "ts-grm-migrate.config.ts");
    await writeFile(
      configPath,
      `export default ${JSON.stringify(
        {
          database: PG_CONFIG,
          models: ["./tests/model/model.ts"],
          migrationsDir: path.join(dir, "migrations"),
          schema: TEST_SCHEMA,
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

  async function cleanupSchema(): Promise<void> {
    await pool
      .query(`drop schema if exists "${TEST_SCHEMA}" cascade`)
      .catch(() => undefined);
  }

  async function tables(): Promise<Array<string>> {
    const { rows } = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name <> '_migrations' order by table_name`,
      [TEST_SCHEMA],
    );
    return rows.map((r) => String(r["table_name"]));
  }

  it("dev：生成并应用迁移，表真的建出来", async () => {
    const code = await runCli(["dev", "--name", "init", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/已生成并应用迁移：\d{14}_init/);
    expect(await tables()).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);
  });

  it("status：无迁移 / 已应用 / 待应用都能正确汇报", async () => {
    await runCli(["status", "--config", configPath]);
    expect(logs.join("\n")).toContain("没有任何迁移");

    logs.length = 0;
    await runCli(["dev", "--name", "init", "--config", configPath]);
    logs.length = 0;
    await runCli(["status", "--config", configPath]);
    expect(logs.join("\n")).toContain("已应用：");
    expect(logs.join("\n")).toContain("没有待应用的迁移");
  });

  it("dev：模型未变时第二次运行不产生新迁移", async () => {
    await runCli(["dev", "--name", "init", "--config", configPath]);
    logs.length = 0;

    const code = await runCli(["dev", "--name", "again", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("无需迁移");
  });

  it("deploy：幂等，重复运行不重复应用", async () => {
    await runCli(["dev", "--name", "init", "--config", configPath]);
    logs.length = 0;

    const code = await runCli(["deploy", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("没有待应用的迁移（已应用 1 个）");
    expect(await tables()).toEqual(["AUTHOR", "BOOK", "TAG", "book_tag_mapping"]);
  });

  it("push：破坏性变更被拒绝（非 --force）；--force 后执行", async () => {
    await runCli(["dev", "--name", "init", "--config", configPath]);
    await pool.query(`create table "${TEST_SCHEMA}".temp_extra (x int)`);

    logs.length = 0;
    errors.length = 0;
    const refused = await runCli(["push", "--config", configPath]);

    expect(refused).toBe(0); // 使用者取消不算失败
    expect(errors.join("\n")).toContain("删除表 temp_extra");
    expect(await tables()).toContain("temp_extra"); // 未被执行

    logs.length = 0;
    const forced = await runCli(["push", "--force", "--config", configPath]);

    expect(forced).toBe(0);
    expect(await tables()).not.toContain("temp_extra");
  });

  it("未知命令返回 1", async () => {
    const code = await runCli(["frobnicate", "--config", configPath]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("未知命令");
  });
});
