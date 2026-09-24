/**
 * CLI 端到端测试 —— **需要真实数据库**，无 PG_HOST 时整体跳过。
 *
 * 模拟「用户项目」：临时目录放配置与迁移目录，`models` 指向本仓库的测试模型，
 * 然后真的调用 `run()` 走完 dev / status / deploy / push。
 *
 * 运行：`PG_HOST=... PG_PASSWORD=... yarn vitest run tests/cli-postgres.test.ts`
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, beforeAll } from "vitest";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** 模型相对 CWD 解析，因此 CWD 固定为仓库根 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const describePg = PG_HOST != null ? describe.sequential : describe.skip;

// 注：这些用例会建/删 schema，需连真实数据库；无 PG_HOST 时整体跳过。
describePg("CLI 端到端（真实数据库）", () => {
  let pool: Pool;
  let dir: string;
  let configPath: string;
  /**
   * 每个测试用**独立 schema**：共用一个 schema 名时，相邻测试的
   * `drop schema cascade` 与 `create schema if not exists` 会互相等待（实测偶发挂起 30s+）。
   */
  let schemaName: string;
  const logs: Array<string> = [];
  const errors: Array<string> = [];

  // 不注入 confirm：让 CLI 走真实逻辑（测试环境非 TTY，破坏性变更会被拒绝）
  const runCli = (argv: ReadonlyArray<string>): Promise<number> =>
    run(argv, REPO_ROOT, {
      log: (m) => logs.push(m),
      errorLog: (m) => errors.push(m),
    });

  beforeAll(async () => {
    // 主机名只解析一次，之后一律用 IP 建连。
    // 直接给 pg 传域名时每次新建连接都要走 getaddrinfo，而本机解析器
    // 偶发抖动会让 pool.connect() 长时间挂起（实测把 CLI 卡到外层超时，
    // 与 migrate 逻辑无关）。解析一次既保留域名的配置方式，
    // 又不让 DNS 抖动污染测试结论。
    try {
      const { address } = await lookup(PG_HOST ?? "");
      PG_CONFIG.host = address;
    } catch {
      // 解析失败就保留域名，让连接错误自然暴露
    }
    pool = new Pool({ ...PG_CONFIG, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    logs.length = 0;
    errors.length = 0;
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-cli-e2e-"));
    schemaName = `cli_e2e_${path.basename(dir).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    configPath = path.join(dir, "ts-grm-migrate.config.ts");
    await writeFile(
      configPath,
      `export default ${JSON.stringify(
        {
          database: PG_CONFIG,
          models: ["./tests/model/model.ts"],
          migrationsDir: path.join(dir, "migrations"),
          schema: schemaName,
          lockPath: path.join(dir, "migrate.lock"),
        },
        null,
        2,
      )};\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await pool
      .query(`drop schema if exists "${schemaName}" cascade`)
      .catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  async function tables(): Promise<Array<string>> {
    const { rows } = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_name <> '_migrations' order by table_name`,
      [schemaName],
    );
    return rows.map((r) => String(r["table_name"]));
  }

  it("dev：生成并应用迁移，表真的建出来", async () => {
    const code = await runCli(["dev", "--name", "init", "--config", configPath]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/已生成并应用迁移：\d{17}_init/);
    expect(await tables()).toEqual(["author", "book", "book_tag_mapping", "tag"]);
  });

  it("dev：省略名字时迁移只用时间戳命名", async () => {
    const code = await runCli(["dev", "--config", configPath]);

    expect(code).toBe(0);
    // 迁移 id 是纯 14 位时间戳，不带下划线后缀
    expect(logs.join("\n")).toMatch(/已生成并应用迁移：\d{17}\b/);
    expect(await tables()).toEqual(["author", "book", "book_tag_mapping", "tag"]);
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
    expect(await tables()).toEqual(["author", "book", "book_tag_mapping", "tag"]);
  });

  it("push：破坏性变更被拒绝（非 --force）；--force 后执行", async () => {
    await runCli(["dev", "--name", "init", "--config", configPath]);
    await pool.query(`create table "${schemaName}".temp_extra (x int)`);

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

  it("resolve --applied：标记为已应用后不再待应用", async () => {
    const migrationsDir = path.join(dir, "migrations");
    await mkdir(migrationsDir, { recursive: true });
    const id = "20260911T120000_manual";
    await writeFile(
      path.join(migrationsDir, `${id}.sql`),
      'create table "MANUAL" (x int);\n',
      "utf8",
    );

    logs.length = 0;
    await runCli(["status", "--config", configPath]);
    expect(logs.join("\n")).toContain(id);

    const code = await runCli(["resolve", "--applied", id, "--config", configPath]);
    expect(code).toBe(0);

    logs.length = 0;
    await runCli(["status", "--config", configPath]);
    expect(logs.join("\n")).toContain("已应用：");
    expect(logs.join("\n")).not.toContain("待应用：");

    logs.length = 0;
    const deployed = await runCli(["deploy", "--config", configPath]);
    expect(deployed).toBe(0);
    expect(logs.join("\n")).toContain("没有待应用的迁移");
  });

  it("resolve --rolled-back：失败迁移阻塞 deploy，清除后恢复", async () => {
    // 放一个执行时会失败的迁移（第二条语句建重复表，事务整体回滚）
    const migrationsDir = path.join(dir, "migrations");
    await mkdir(migrationsDir, { recursive: true });
    const badId = "20260911T120000_bad";
    const badFile = path.join(migrationsDir, `${badId}.sql`);
    await writeFile(
      badFile,
      'create table "TMP_A" (x int);\n\ncreate table "TMP_A" (y int);\n',
      "utf8",
    );

    // 1) 首次 deploy 失败并记入历史
    await expect(runCli(["deploy", "--config", configPath])).rejects.toThrow(/执行失败/);

    logs.length = 0;
    await runCli(["status", "--config", configPath]);
    expect(logs.join("\n")).toContain("[失败]");

    // 2) 再 deploy：被失败记录拦下（而不是重复执行）
    await expect(runCli(["deploy", "--config", configPath])).rejects.toThrow(/上次执行失败/);

    // 3) resolve --rolled-back 清除失败记录
    logs.length = 0;
    const resolved = await runCli([
      "resolve",
      "--rolled-back",
      badId,
      "--config",
      configPath,
    ]);
    expect(resolved).toBe(0);
    expect(logs.join("\n")).toContain("已标记回滚");

    // 4) 修好迁移后 deploy 成功
    await writeFile(badFile, 'create table "TMP_A" (x int);\n', "utf8");
    logs.length = 0;
    const deployed = await runCli(["deploy", "--config", configPath]);

    expect(deployed).toBe(0);
    expect(logs.join("\n")).toContain(`已应用 ${badId}`);
    expect(await tables()).toContain("TMP_A");
  });

  it("对账：迁移后数据库被手工改动，会告警并指出表与具体差异", async () => {
    await runCli(["dev", "--name", "init", "--config", configPath]);
    // 模拟「有人直连数据库改了结构」
    await pool.query(`alter table "${schemaName}"."author" add column "LEGACY" int`);

    logs.length = 0;
    errors.length = 0;
    const code = await runCli(["deploy", "--config", configPath]);

    expect(code).toBe(0);
    const reported = errors.join("\n");
    expect(reported).toContain("对账发现数据库与模型不一致");
    expect(reported).toContain(`库 ${PG_CONFIG.database}`); // 指认哪个库
    expect(reported).toContain("表 author"); // 指认哪张表
    expect(reported).toContain("多出列 LEGACY"); // 说明发生了什么
  });

  it("对账：结构正常时不产生噪声告警", async () => {
    await runCli(["dev", "--name", "init", "--config", configPath]);

    logs.length = 0;
    errors.length = 0;
    await runCli(["deploy", "--config", configPath]);

    expect(errors.join("\n")).not.toContain("对账");
  });

  it("历史表：失败留 error 摘要 + logs 详情；回滚写 rolled_back_at 且保留记录", async () => {
    const migrationsDir = path.join(dir, "migrations");
    await mkdir(migrationsDir, { recursive: true });
    const badId = "20260911T120000_bad";
    await writeFile(
      path.join(migrationsDir, `${badId}.sql`),
      'create table "TMP_C" (x int);\n\ncreate table "TMP_C" (y int);\n',
      "utf8",
    );

    await expect(runCli(["deploy", "--config", configPath])).rejects.toThrow(/执行失败/);

    const history = `"${schemaName}"."_migrations"`;
    const failed = await pool.query(
      `select failed, error, logs, rolled_back_at from ${history} where id = $1`,
      [badId],
    );
    expect(failed.rows[0]!.failed).toBe(true);
    expect(String(failed.rows[0]!.error)).toContain("already exists"); // 摘要
    expect(String(failed.rows[0]!.logs)).toContain(badId); // 详情里有迁移名
    expect(String(failed.rows[0]!.logs)).toContain("事务已回滚"); // 与详情兼容
    expect(failed.rows[0]!.rolled_back_at).toBeNull();

    await runCli(["resolve", "--rolled-back", badId, "--config", configPath]);

    const rolledBack = await pool.query(
      `select failed, rolled_back_at from ${history} where id = $1`,
      [badId],
    );
    expect(rolledBack.rows).toHaveLength(1); // 记录保留（审计），不是删除
    expect(rolledBack.rows[0]!.rolled_back_at).not.toBeNull();
    expect(rolledBack.rows[0]!.failed).toBe(false);
  });

  it("resolve：缺参数时报错并返回 1", async () => {
    const code = await runCli(["resolve", "--config", configPath]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--applied");
  });

  it("未知命令返回 1", async () => {
    const code = await runCli(["frobnicate", "--config", configPath]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("未知命令");
  });
});
