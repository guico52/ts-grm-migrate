#!/usr/bin/env node
/**
 * CLI 入口 —— 装好依赖后，在项目根敲命令即可。
 *
 *   ts-grm-migrate dev --name init    对比模型与数据库，生成并应用一个迁移
 *   ts-grm-migrate deploy             应用所有未应用的迁移（部署 / CI）
 *   ts-grm-migrate push [--force]     直接同步成模型的样子（不记历史）
 *   ts-grm-migrate status             查看迁移状态
 *
 * 配置文件在项目根自动查找（见 `src/config.ts` 的候选名）。
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { CONFIG_FILENAMES, loadConfig } from "./config.js";
import { MigrationAbortedError } from "./migrator.js";
import { createRuntime } from "./runtime.js";
import type { DestructiveChange, Diff } from "./diff/types.js";
import type { ParsedArgs, RunOptions } from "./cli/types.js";
import type { Runtime } from "./runtime.js";

export type { ParsedArgs, RunOptions } from "./cli/types.js";

const USAGE = `ts-grm-migrate —— ts-grm 的 schema 迁移工具

用法：
  ts-grm-migrate <命令> [选项]

命令：
  dev --name <名字>   对比模型与数据库，生成并应用一个迁移（开发用）
  deploy              应用所有未应用的迁移（部署 / CI 用）
  push                直接把数据库同步成模型的样子（不写迁移文件、不记历史）
  status              查看已应用 / 待应用的迁移

选项：
  --config <path>     指定配置文件（默认在项目根自动查找）
  --force             破坏性变更不询问，直接执行（非交互环境下必需）
  -h, --help          显示本帮助

配置文件（项目根，任选其一）：
  ${CONFIG_FILENAMES.join("\n  ")}
`;

/** 解析 argv：`--k v` / `--k=v` / `-h` / 位置参数（第一个位置参数是命令） */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const flags = new Map<string, string | true>();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("-")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      flags.set(arg.slice(1), true);
    } else if (command == null) {
      command = arg;
    }
  }
  return { command, flags };
}

/**
 * 执行一条命令，返回退出码。
 *
 * 不调用 `process.exit`，也不直接写 console（可注入），便于测试。
 */
export async function run(
  argv: ReadonlyArray<string>,
  cwd: string,
  options: RunOptions = {},
): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const errorLog = options.errorLog ?? ((message: string) => console.error(message));
  const { command, flags } = parseArgs(argv);

  if (command == null || command === "help" || flags.has("help") || flags.has("h")) {
    log(USAGE);
    return 0;
  }

  const configFlag = flags.get("config");
  const { config, path: configFile } = await loadConfig(
    cwd,
    typeof configFlag === "string" ? configFlag : undefined,
  );

  const runtime = await createRuntime(config, cwd, {
    confirm: options.confirm ?? makeConfirm(flags.has("force"), errorLog),
  });

  try {
    log(`配置：${configFile}`);
    switch (command) {
      case "dev":
        return await runDev(runtime, flags.get("name"), log, errorLog);
      case "deploy":
        return await runDeploy(runtime, log);
      case "push":
        return await runPush(runtime, log);
      case "status":
        return await runStatus(runtime, log);
      default:
        errorLog(`未知命令 "${command}"。`);
        log(USAGE);
        return 1;
    }
  } catch (e) {
    if (e instanceof MigrationAbortedError) {
      // 使用者主动取消：不是失败，不让调用方处理
      log("已取消。");
      return 0;
    }
    throw e;
  } finally {
    await runtime.close();
  }
}

async function runDev(
  runtime: Runtime,
  name: string | true | undefined,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): Promise<number> {
  if (typeof name !== "string" || name.trim() === "") {
    errorLog("dev 需要 --name <迁移名>，例如：ts-grm-migrate dev --name init");
    return 1;
  }
  const result = await runtime.migrator.dev({ name: name.trim() });
  if (!result.applied) {
    log("模型与数据库结构一致，无需迁移。");
    return 0;
  }
  log(`已生成并应用迁移：${result.migrationId}`);
  return 0;
}

async function runDeploy(runtime: Runtime, log: (message: string) => void): Promise<number> {
  const result = await runtime.migrator.deploy();
  if (result.applied.length === 0) {
    log(`没有待应用的迁移（已应用 ${result.skipped} 个）。`);
    return 0;
  }
  for (const id of result.applied) {
    log(`已应用 ${id}`);
  }
  return 0;
}

async function runPush(runtime: Runtime, log: (message: string) => void): Promise<number> {
  const result = await runtime.migrator.push();
  if (result.statements.length === 0) {
    log("模型与数据库结构一致，无需同步。");
    return 0;
  }
  log(`已同步：应用了 ${result.statements.length} 条语句。`);
  return 0;
}

async function runStatus(runtime: Runtime, log: (message: string) => void): Promise<number> {
  const status = await runtime.migrator.status();
  if (status.applied.length === 0 && status.pending.length === 0) {
    log("没有任何迁移。");
    return 0;
  }
  if (status.applied.length > 0) {
    log("已应用：");
    for (const applied of status.applied) {
      log(`  ${applied.id}  ${applied.appliedAt.toISOString()}${applied.failed ? "  [失败]" : ""}`);
    }
  }
  if (status.pending.length > 0) {
    log("待应用：");
    for (const id of status.pending) {
      log(`  ${id}`);
    }
  } else {
    log("没有待应用的迁移。");
  }
  return 0;
}

/** 破坏性变更的交互确认；`--force` 或非 TTY 下直接放行/拒绝 */
function makeConfirm(
  force: boolean,
  errorLog: (message: string) => void,
): (diff: Diff) => Promise<boolean> {
  return async (diff: Diff): Promise<boolean> => {
    if (force) {
      return true;
    }
    printDestructive(diff.destructive, errorLog);
    if (!process.stdin.isTTY) {
      errorLog("当前不是交互环境，无法确认；确认后请加 --force 重试。");
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("是否继续？(y/N) ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}

function printDestructive(
  changes: ReadonlyArray<DestructiveChange>,
  errorLog: (message: string) => void,
): void {
  errorLog("检测到破坏性变更（可能丢失数据）：");
  for (const change of changes) {
    switch (change.kind) {
      case "DROP_TABLE":
        errorLog(`  - 删除表 ${change.table}`);
        break;
      case "DROP_COLUMN":
        errorLog(`  - 删除列 ${change.table}.${change.column}`);
        break;
      case "ALTER_COLUMN":
        errorLog(`  - 修改列类型 ${change.table}.${change.column} → ${change.type}`);
        break;
    }
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2), process.cwd());
  } catch (e) {
    if (e instanceof MigrationAbortedError) {
      console.log("已取消。");
      process.exitCode = 0;
      return;
    }
    console.error(`错误：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// 仅作为可执行入口时运行（被 import 时不触发，便于测试）
if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
