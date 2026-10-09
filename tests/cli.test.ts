import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, run } from "../src/cli";
import { loadConfig } from "../src/config";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("parseArgs", () => {
  it("第一个位置参数是命令", () => {
    expect(parseArgs(["deploy"]).command).toBe("deploy");
  });

  it("--key value 形式", () => {
    const { command, flags } = parseArgs(["dev", "--name", "init"]);
    expect(command).toBe("dev");
    expect(flags.get("name")).toBe("init");
  });

  it("--key=value 形式", () => {
    expect(parseArgs(["dev", "--name=init"]).flags.get("name")).toBe("init");
  });

  it("无值选项视为布尔", () => {
    expect(parseArgs(["push", "--force"]).flags.get("force")).toBe(true);
  });

  it("选项后紧跟另一个选项时不吞掉它", () => {
    const { flags } = parseArgs(["dev", "--name", "--force"]);
    expect(flags.get("name")).toBe(true);
    expect(flags.get("force")).toBe(true);
  });

  it("短选项", () => {
    expect(parseArgs(["-h"]).flags.get("h")).toBe(true);
  });

  it("-n 是 --name 的别名，可取值", () => {
    const { command, flags } = parseArgs(["dev", "-n", "init"]);
    expect(command).toBe("dev");
    expect(flags.get("name")).toBe("init");
  });

  it("-n=value 形式", () => {
    expect(parseArgs(["dev", "-n=init"]).flags.get("name")).toBe("init");
  });

  it("-n 后跟另一个选项时不吃掉它", () => {
    const { flags } = parseArgs(["dev", "-n", "--force"]);
    expect(flags.get("name")).toBe(true);
    expect(flags.get("force")).toBe(true);
  });

  it("未登记的短选项不吞参数（-h dev 的命令仍是 dev）", () => {
    const { command, flags } = parseArgs(["-h", "dev"]);
    expect(command).toBe("dev");
    expect(flags.get("h")).toBe(true);
  });

  it("无参数时命令为 undefined", () => {
    expect(parseArgs([]).command).toBeUndefined();
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(name: string, source: string): Promise<void> {
    await writeFile(path.join(dir, name), source, "utf8");
  }

  it("自动查找候选文件名", async () => {
    await writeConfig(
      "ts-grm-migrate.config.mjs",
      "export default { database: { host: 'h' }, models: ['./m'] };",
    );
    const loaded = await loadConfig(dir);
    expect(loaded.config.models).toEqual(["./m"]);
    expect(loaded.path.endsWith("ts-grm-migrate.config.mjs")).toBe(true);
  });

  it("找不到时报错并列出候选名", async () => {
    await expect(loadConfig(dir)).rejects.toThrow(/ts-grm-migrate\.config\.ts/);
  });

  it("缺少 models 报错", async () => {
    await writeConfig("ts-grm-migrate.config.mjs", "export default { database: {} };");
    await expect(loadConfig(dir)).rejects.toThrow(/models/);
  });

  it("缺少 database 报错", async () => {
    await writeConfig("ts-grm-migrate.config.mjs", "export default { models: ['./m'] };");
    await expect(loadConfig(dir)).rejects.toThrow(/database/);
  });

  it("默认导出不是对象时报错", async () => {
    await writeConfig("ts-grm-migrate.config.mjs", "export default 42;");
    await expect(loadConfig(dir)).rejects.toThrow(/configuration object/);
  });

  it("显式路径优先", async () => {
    await writeConfig(
      "custom.config.mjs",
      "export default { database: {}, models: ['./x'] };",
    );
    const loaded = await loadConfig(dir, "custom.config.mjs");
    expect(loaded.config.models).toEqual(["./x"]);
  });

  it("拒绝配置文件中未知的输出语言", async () => {
    await writeConfig(
      "ts-grm-migrate.config.mjs",
      "export default { database: {}, models: ['./m'], language: 'fr' };",
    );
    await expect(loadConfig(dir)).rejects.toThrow(/unsupported language "fr"/);
  });
});

describe("CLI 入口结构（防止循环依赖死锁）", () => {
  it("cli.ts 顶层不得使用 top-level await", async () => {
    const source = await readFile(path.join(HERE, "../src/cli.ts"), "utf8");
    // cli.js 被 index.js 再导出（库入口对外提供 run/parseArgs），
    // 而使用者的配置文件又会 import 库入口 —— 若 cli.js 停在 TLA，
    // 环上两个模块会互相等待而死锁（实测会静默退出）。
    expect(source).not.toMatch(/^await /m);
    expect(source).not.toMatch(/isEntryPoint|void main\(\)/);
  });
});

describe("CLI 可执行入口（需要先 build）", () => {
  const distCli = path.resolve(HERE, "../dist/bin.mjs");
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tsgrm-cli-entry-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("通过 node_modules/.bin 这类符号链接启动时能正常运行（不静默退出）", async () => {
    if (!existsSync(distCli)) {
      return; // 未构建则跳过（CI 上先 build 再跑测试即可覆盖）
    }
    // 模拟 node_modules/.bin/tgm：符号链接指向真实产物
    const link = path.join(dir, "tgm");
    await symlink(distCli, link);

    const { stdout } = await execFileAsync(process.execPath, [link, "--help"]);

    expect(stdout).toContain("ts-grm-migrate");
    expect(stdout).toContain("Usage");
  });

  it("配置的语言也用于可执行入口的错误前缀", async () => {
    if (!existsSync(distCli)) return;
    const configFile = path.join(dir, "config.mjs");
    await writeFile(configFile, `export default {
      dialect: "sqlite",
      language: "zh-CN",
      database: { file: ":memory:" },
      models: ["./missing.mjs"],
      schema: "unsupported"
    };`);
    await expect(execFileAsync(process.execPath, [distCli, "dev", "--config", configFile], { cwd: dir }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("错误:") });
  });

  it.each([
    { language: "zh-CN", flags: [], prefix: "错误: 加载模型失败", hint: "提示：模型名称" },
    { language: "en", flags: ["--lang", "zh-CN"], prefix: "错误: 加载模型失败", hint: "提示：模型名称" },
    { language: "zh-CN", flags: ["--lang", "en"], prefix: "Error: Failed to load models", hint: "Hint: Model name" },
  ])("模型命名错误遵循语言优先级：$language / $flags", async ({ language, flags, prefix, hint }) => {
    if (!existsSync(distCli)) return;
    await symlink(path.resolve(HERE, "../node_modules"), path.join(dir, "node_modules"), "dir");
    await writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    await writeFile(path.join(dir, "model.js"), `
      import { model, prop } from "@ts-grm/core";
      export const USER = model("sys_user", "id", class { id = prop.i64(); });
    `);
    await writeFile(path.join(dir, "ts-grm-migrate.config.mjs"), `export default ${JSON.stringify({
      dialect: "sqlite", language, database: { file: ":memory:" }, models: ["./model.js"],
    })};`);
    try {
      await execFileAsync(process.execPath, [distCli, "check", ...flags], { cwd: dir });
      expect.fail("An invalid model name must fail");
    } catch (error) {
      const failure = error as { code: number; stderr: string };
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain(prefix);
      expect(failure.stderr).toContain(hint);
      expect(failure.stderr).toContain("SysUser");
      expect(failure.stderr).not.toContain("ESM");
      if (hint.startsWith("提示")) expect(failure.stderr).not.toMatch(/Illegal model|Must follow|Hint:/);
    }
  });

  it.each([
    { config: { language: "zh-CN", models: ["./model.js"] }, args: ["check"], expected: "缺少数据库连接设置", absent: "missing database" },
    { config: { language: "zh-CN", database: {} }, args: ["check"], expected: "缺少 models", absent: "missing models" },
    { config: { language: "zh-CN", database: {}, models: ["./model.js"], dialect: "unknown" }, args: ["check"], expected: "未知方言", absent: "Unknown dialect" },
    { config: { language: "zh-CN", dialect: "sqlite", schema: "invalid", database: { file: ":memory:" }, models: ["./model.js"] }, args: ["check"], expected: "不支持 schema", absent: "does not support schema" },
    { config: { language: "zh-CN", dialect: "sqlite", database: { file: ":memory:" }, models: ["./missing.js"] }, args: ["check"], expected: "找不到文件或依赖", absent: "Illegal path" },
    { config: { language: "zh-CN", dialect: "sqlite", database: { file: ":memory:" }, models: ["./model.js"] }, args: ["resolve", "--applied", "missing"], expected: "未找到迁移", absent: "was not found" },
  ])("真实入口本地化配置与运行错误：$expected", async ({ config, args, expected, absent }) => {
    if (!existsSync(distCli)) return;
    await writeFile(path.join(dir, "ts-grm-migrate.config.mjs"), `export default ${JSON.stringify(config)};`);
    const failure = await execFileAsync(process.execPath, [distCli, ...args], { cwd: dir }).catch((error) => error);
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("错误:");
    expect(failure.stderr).toContain(expected);
    expect(failure.stderr).not.toContain(absent);
  });

  it("配置未加载时也使用显式指定的中文", async () => {
    if (!existsSync(distCli)) return;
    const failure = await execFileAsync(process.execPath, [distCli, "check", "--lang", "zh-CN"], { cwd: dir }).catch((error) => error);
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("未找到配置文件");
    expect(failure.stderr).not.toContain("Configuration file not found");
  });

  it("待执行迁移和 SQL 执行失败均使用中文，原始 SQL 错误仅在 detail 中显示", async () => {
    if (!existsSync(distCli)) return;
    await writeFile(path.join(dir, "ts-grm-migrate.config.mjs"), `export default ${JSON.stringify({
      language: "zh-CN", dialect: "sqlite", database: { file: ":memory:" }, models: ["./missing.js"], migrationsDir: "./migrations",
    })};`);
    await mkdir(path.join(dir, "migrations"));
    await writeFile(path.join(dir, "migrations/001_init.sql"), "not a valid sql;");
    const pending = await execFileAsync(process.execPath, [distCli, "dev"], { cwd: dir }).catch((error) => error);
    expect(pending.code).toBe(1);
    expect(pending.stderr).toContain("生成新迁移前必须先应用待执行迁移");
    expect(pending.stderr).not.toContain("Pending migrations");
    const failed = await execFileAsync(process.execPath, [distCli, "deploy"], { cwd: dir }).catch((error) => error);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('迁移 "001_init" 执行失败');
    expect(failed.stderr).toContain("事务已回滚");
    expect(failed.stderr).toContain("SQLITE_ERROR");
    expect(failed.stderr).not.toMatch(/Migration|Statement failed|syntax error/);
    const detail = await execFileAsync(process.execPath, [distCli, "deploy", "--detail"], { cwd: dir }).catch((error) => error);
    expect(detail.stderr).toContain("原始诊断");
    expect(detail.stderr).toContain("syntax error");
  });
});

describe("run（不触库的路径）", () => {
  it("--help 打印用法并返回 0", async () => {
    const out: Array<string> = [];
    const code = await run(["--help"], process.cwd(), {
      log: (m) => out.push(m),
      errorLog: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("ts-grm-migrate");
  });

  it("无参数时打印用法并返回 0", async () => {
    const out: Array<string> = [];
    const code = await run([], process.cwd(), {
      log: (m) => out.push(m),
      errorLog: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage");
  });

  it("配置缺失时抛出可读错误", async () => {
    await expect(
      run(["status"], path.join(tmpdir(), "tsgrm-no-config-here"), {
        log: () => undefined,
        errorLog: () => undefined,
      }),
    ).rejects.toThrow(/Configuration file not found/);
  });

  it("--lang zh-CN 显示中文帮助，默认显示英文", async () => {
    const out: Array<string> = [];
    expect(await run(["--help", "--lang", "zh-CN"], process.cwd(), { log: (m) => out.push(m) })).toBe(0);
    expect(out.join("\n")).toContain("用法");
  });

  it("无效语言在加载配置前报错", async () => {
    const errors: Array<string> = [];
    expect(await run(["deploy", "--lang", "de"], process.cwd(), { errorLog: (m) => errors.push(m) })).toBe(1);
    expect(errors.join("\n")).toContain("Unsupported language");
  });

  it("--detail 不吞掉后面的命令", () => {
    expect(parseArgs(["--detail", "deploy"]).command).toBe("deploy");
  });
});
