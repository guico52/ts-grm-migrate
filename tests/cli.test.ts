import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, run } from "../src/cli";
import { loadConfig } from "../src/config";

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
    await expect(loadConfig(dir)).rejects.toThrow(/配置对象/);
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
    expect(out.join("\n")).toContain("用法");
  });

  it("配置缺失时抛出可读错误", async () => {
    await expect(
      run(["status"], path.join(tmpdir(), "tsgrm-no-config-here"), {
        log: () => undefined,
        errorLog: () => undefined,
      }),
    ).rejects.toThrow(/未找到配置文件/);
  });
});
