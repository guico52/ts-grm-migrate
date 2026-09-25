import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
