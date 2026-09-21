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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAMES, loadConfig } from "./config.js";
import { abnormalDrift } from "./drift.js";
import { MigrationAbortedError } from "./migrator.js";
import { createRuntime } from "./runtime.js";
import type { DestructiveChange, Diff } from "./diff/types.js";
import type { SchemaDrift } from "./drift.js";
import type { MigrateConfig } from "./config.js";
import type { ParsedArgs, RunOptions } from "./cli/types.js";
import type { Runtime } from "./runtime.js";

export type { ParsedArgs, RunOptions } from "./cli/types.js";

const USAGE = `ts-grm-migrate —— ts-grm 的 schema 迁移工具

用法：
  ts-grm-migrate <命令> [选项]

命令：
  dev [--name <名字>]  对比模型与数据库，生成并应用一个迁移（开发用）
                       不给名字时用纯时间戳命名
  deploy              应用所有未应用的迁移（部署 / CI 用）
  push                直接把数据库同步成模型的样子（不写迁移文件、不记历史）
  status              查看已应用 / 待应用的迁移
  resolve --applied <id>      把迁移标记为已应用（SQL 已手工执行过）
  resolve --rolled-back <id>  标记迁移已回滚，它将重新待应用

选项：
  -n, --name <名字>   迁移名（dev 命令用；可省略，省略时只用时间戳）
  --config <path>     指定配置文件（默认在项目根自动查找）
  --force             破坏性变更不询问，直接执行（非交互环境下必需）
  -h, --help          显示本帮助

配置文件（项目根，任选其一）：
  ${CONFIG_FILENAMES.join("\n  ")}
`;

/** 解析 argv：`--k v` / `--k=v` / `-h` / 位置参数（第一个位置参数是命令） */
/**
 * 短选项 → 长选项别名。
 * 只有登记过的短选项才会吃掉下一个参数，其余一律按布尔开关处理
 * （否则 `-h dev` 会把命令名当成 help 的值）。
 */
const SHORT_FLAG_ALIASES: Record<string, string> = { n: "name" };

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
      const short = arg.slice(1);
      const eq = short.indexOf("=");
      if (eq >= 0) {
        const key = short.slice(0, eq);
        flags.set(SHORT_FLAG_ALIASES[key] ?? key, short.slice(eq + 1));
        continue;
      }
      const canonical = SHORT_FLAG_ALIASES[short];
      const next = argv[i + 1];
      if (canonical != null && next != null && !next.startsWith("-")) {
        flags.set(canonical, next);
        i++;
      } else {
        flags.set(canonical ?? short, true);
      }
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
  const dbLabel = describeDatabase(config);

  try {
    log(`配置：${configFile}`);
    switch (command) {
      case "dev":
        return await runDev(runtime, flags.get("name"), dbLabel, log, errorLog);
      case "deploy":
        return await runDeploy(runtime, dbLabel, log, errorLog);
      case "push":
        return await runPush(runtime, dbLabel, log, errorLog);
      case "status":
        return await runStatus(runtime, log);
      case "resolve":
        return await runResolve(runtime, flags, log, errorLog);
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
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): Promise<number> {
  // name 可选：不给就用纯时间戳命名（由 migrator 层的 generateMigrationId 负责）
  const migrationName = typeof name === "string" ? name.trim() : "";
  const result = await runtime.migrator.dev({ name: migrationName });
  if (!result.applied) {
    log("模型与数据库结构一致，无需迁移。");
    return 0;
  }
  log(`已生成并应用迁移：${result.migrationId}`);
  reportDrift(result.drift, dbLabel, log, errorLog);
  return 0;
}

async function runDeploy(
  runtime: Runtime,
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): Promise<number> {
  const result = await runtime.migrator.deploy();
  if (result.applied.length === 0) {
    log(`没有待应用的迁移（已应用 ${result.skipped} 个）。`);
  } else {
    for (const id of result.applied) {
      log(`已应用 ${id}`);
    }
  }
  reportDrift(result.drift, dbLabel, log, errorLog);
  return 0;
}

async function runPush(
  runtime: Runtime,
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): Promise<number> {
  const result = await runtime.migrator.push();
  if (result.statements.length === 0) {
    log("模型与数据库结构一致，无需同步。");
  } else {
    log(`已同步：应用了 ${result.statements.length} 条语句。`);
  }
  reportDrift(result.drift, dbLabel, log, errorLog);
  return 0;
}

/** 数据库的可读标识（用于对账消息里指认「哪个库」） */
function describeDatabase(config: MigrateConfig): string {
  const schema = config.schema ?? "public";
  const database = config.database.database;
  return database != null && database !== ""
    ? `库 ${database}，schema ${schema}`
    : `schema ${schema}`;
}

/**
 * 输出对账结果。已知限制（如 CHECK 表达式）降级为一行提示，不当作异常。
 */
function reportDrift(
  drift: ReadonlyArray<SchemaDrift>,
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): void {
  const abnormal = abnormalDrift(drift);
  const knownCount = drift.length - abnormal.length;

  if (abnormal.length > 0) {
    errorLog(`\n⚠ 对账发现数据库与模型不一致（${dbLabel}）：`);
    for (const item of abnormal) {
      errorLog(`  - 表 ${item.table}：${item.summary}`);
    }
    errorLog("这通常意味着迁移未完整生效，或数据库被手工改动过。");
  }
  if (knownCount > 0) {
    log(`（另有 ${knownCount} 处因已知限制无法比对（如 CHECK 约束表达式），已忽略）`);
  }
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

/** 手工修正迁移状态（失败后的恢复途径） */
async function runResolve(
  runtime: Runtime,
  flags: ReadonlyMap<string, string | true>,
  log: (message: string) => void,
  errorLog: (message: string) => void,
): Promise<number> {
  const applied = flags.get("applied");
  const rolledBack = flags.get("rolled-back");

  if (typeof applied === "string" && typeof rolledBack === "string") {
    errorLog("--applied 与 --rolled-back 只能选一个。");
    return 1;
  }
  if (typeof applied === "string") {
    await runtime.migrator.resolve({ migration: applied, action: "applied" });
    log(`已标记为已应用：${applied}`);
    return 0;
  }
  if (typeof rolledBack === "string") {
    await runtime.migrator.resolve({ migration: rolledBack, action: "rolled-back" });
    log(`已标记回滚（将重新待应用）：${rolledBack}`);
    return 0;
  }
  errorLog("resolve 需要 --applied <迁移 id> 或 --rolled-back <迁移 id>。");
  return 1;
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

/**
 * 是否作为可执行入口运行（被 import 时不触发）。
 *
 * **必须对 argv[1] 取 realpath**：通过 `node_modules/.bin/xxx` 这类**符号链接**启动时，
 * argv[1] 是链接路径而 import.meta.url 是真实路径，直接比较不相等 ——
 * 表现为「命令退出码 0 但什么都没做」（实测踩过）。
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 == null) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // 刻意**不用 top-level await**：cli.js 被 index.js 再导出（库入口对外提供 run/parseArgs），
  // 而使用者的配置文件又会 `import { defineConfig } from "ts-grm-migrate"` →
  // 形成 cli.js → config → index.js → cli.js 的环。若 cli.js 停在 TLA，
  // 环上两个模块会互相等待而死锁（表现为 `unsettled top-level await` 后静默退出）。
  // 这里 fire-and-forget：cli.js 求值立即完成，进程由 main() 内部的 I/O 保持存活。
  main().catch((e: unknown) => {
    console.error(`错误：${(e as Error).message}`);
    process.exitCode = 1;
  });
}
