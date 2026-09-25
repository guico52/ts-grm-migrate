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
import { loadConfig } from "./config.js";
import { messages, type CliLanguage, type CliMessages } from "./cli/messages.js";
import { abnormalDrift } from "./drift.js";
import { MigrationAbortedError, type MigrationProgress } from "./migrator.js";
import { createRuntime } from "./runtime.js";
import type { DestructiveChange, Diff } from "./diff/types.js";
import type { SchemaDrift } from "./drift.js";
import type { MigrateConfig } from "./config.js";
import type { ParsedArgs, RunOptions } from "./cli/types.js";
import type { Runtime } from "./runtime.js";

export type { ParsedArgs, RunOptions } from "./cli/types.js";

const BOOLEAN_FLAGS = new Set(["help", "h", "force", "detail"]);

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
      if (!BOOLEAN_FLAGS.has(name) && next != null && !next.startsWith("-")) {
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
  const lang = flags.get("lang");
  const initialLanguage: CliLanguage = lang === "zh-CN" ? "zh-CN" : "en";
  let m = messages(initialLanguage);

  if (lang != null && lang !== "en" && lang !== "zh-CN") {
    errorLog(m.invalidLanguage(String(lang)));
    return 1;
  }

  if (command == null || command === "help" || flags.has("help") || flags.has("h")) {
    log(m.usage);
    return 0;
  }
  if (flags.has("detail") && flags.get("detail") !== true) {
    errorLog(m.invalidOption("detail"));
    return 1;
  }
  if (!["dev", "deploy", "push", "status", "resolve"].includes(command)) {
    errorLog(m.unknownCommand(command));
    log(m.usage);
    return 1;
  }

  const detail = flags.has("detail");
  const configFlag = flags.get("config");
  const { config, path: configFile } = await loadConfig(
    cwd,
    typeof configFlag === "string" ? configFlag : undefined,
  );
  const language: CliLanguage = lang === "en" || lang === "zh-CN" ? lang : config.language ?? "en";
  m = messages(language);
  options.onLanguage?.(language);

  const runtime = await createRuntime(config, cwd, {
    confirm: options.confirm ?? makeConfirm(flags.has("force"), errorLog, m),
    driftLanguage: language,
    ...(detail ? { onProgress: (event: MigrationProgress) => reportProgress(event, log, m) } : {}),
  });
  const dbLabel = describeDatabase(config);

  try {
    if (detail) {
      log(m.config(configFile));
      log(m.target(dbLabel));
    }
    switch (command) {
      case "dev":
        return await runDev(runtime, flags.get("name"), dbLabel, log, errorLog, m, detail);
      case "deploy":
        return await runDeploy(runtime, dbLabel, log, errorLog, m, detail);
      case "push":
        return await runPush(runtime, dbLabel, log, errorLog, m, detail);
      case "status":
        return await runStatus(runtime, log, m);
      case "resolve":
        return await runResolve(runtime, flags, log, errorLog, m);
      default:
        return 1;
    }
  } catch (e) {
    if (e instanceof MigrationAbortedError) {
      // 使用者主动取消：不是失败，不让调用方处理
      log(m.cancelled);
      return 0;
    }
    throw e;
  } finally {
    await runtime.close();
  }
}

function reportProgress(event: MigrationProgress, log: (message: string) => void, m: CliMessages): void {
  switch (event.kind) {
    case "process-lock": log(m.detailProcessLock(event.path)); break;
    case "database-lock": log(m.detailDatabaseLock(event.key)); break;
    case "sql": log(m.detailSql(event.sql)); break;
    case "migration-start": log(m.detailMigration(event.id)); break;
    case "migration-applied": log(m.detailApplied(event.id)); break;
  }
}

async function runDev(
  runtime: Runtime,
  name: string | true | undefined,
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
  m: CliMessages,
  detail: boolean,
): Promise<number> {
  // name 可选：不给就用纯时间戳命名（由 migrator 层的 generateMigrationId 负责）
  const migrationName = typeof name === "string" ? name.trim() : "";
  const result = await runtime.migrator.dev({ name: migrationName });
  if (!result.applied) {
    log(m.devNoop(dbLabel));
    return 0;
  }
  log(m.devApplied(result.migrationId!, dbLabel));
  reportDrift(result.drift, dbLabel, log, errorLog, m, detail);
  return 0;
}

async function runDeploy(
  runtime: Runtime,
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
  m: CliMessages,
  detail: boolean,
): Promise<number> {
  const result = await runtime.migrator.deploy();
  if (result.applied.length === 0) {
    log(m.deployNoop(dbLabel));
  } else {
    log(m.deployApplied(result.applied.length, dbLabel));
  }
  if (detail && result.skipped > 0) log(m.detailSkipped(result.skipped));
  reportDrift(result.drift, dbLabel, log, errorLog, m, detail);
  return 0;
}

async function runPush(
  runtime: Runtime,
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
  m: CliMessages,
  detail: boolean,
): Promise<number> {
  const result = await runtime.migrator.push();
  if (result.statements.length === 0) {
    log(m.pushNoop(dbLabel));
  } else {
    log(m.pushApplied(result.statements.length, dbLabel));
  }
  reportDrift(result.drift, dbLabel, log, errorLog, m, detail);
  return 0;
}

/** 数据库的可读标识（用于对账消息里指认「哪个库」） */
function describeDatabase(config: MigrateConfig): string {
  const dialect = config.dialect ?? "postgres";
  if (dialect === "sqlite") return `sqlite ${config.database.file ?? ":memory:"}`;
  const database = config.database.database ?? (dialect === "oracle" && config.database.connectionString == null ? "FREEPDB1" : undefined);
  const schema = config.schema ?? (dialect === "mssql" ? "dbo" : dialect === "postgres" ? "public" : dialect === "oracle" ? config.database.user : undefined);
  return [dialect, database ?? (config.database.connectionString ? "(connection string)" : "(default database)"), schema].filter((part) => part != null && part !== "").join("/");
}

/**
 * 输出对账结果。已知限制（如 CHECK 表达式）降级为一行提示，不当作异常。
 */
function reportDrift(
  drift: ReadonlyArray<SchemaDrift>,
  dbLabel: string,
  log: (message: string) => void,
  errorLog: (message: string) => void,
  m: CliMessages,
  detail: boolean,
): void {
  const abnormal = abnormalDrift(drift);
  const knownCount = drift.length - abnormal.length;

  if (abnormal.length > 0) {
    errorLog(m.drift(dbLabel));
    for (const item of abnormal) {
      errorLog(m.driftTable(item.table, item.summary));
    }
    errorLog(m.driftHint);
  }
  if (detail && knownCount > 0) {
    log(m.knownDrift(knownCount));
  }
}

async function runStatus(runtime: Runtime, log: (message: string) => void, m: CliMessages): Promise<number> {
  const status = await runtime.migrator.status();
  if (status.applied.length === 0 && status.pending.length === 0) {
    log(m.noMigrations);
    return 0;
  }
  if (status.applied.length > 0) {
    log(m.appliedHeading);
    for (const applied of status.applied) {
      log(`  ${applied.id}  ${applied.appliedAt.toISOString()}${applied.failed ? `  [${m.failed}]` : ""}`);
    }
  }
  if (status.pending.length > 0) {
    log(m.pendingHeading);
    for (const id of status.pending) {
      log(`  ${id}`);
    }
  } else {
    log(m.noPending);
  }
  return 0;
}

/** 手工修正迁移状态（失败后的恢复途径） */
async function runResolve(
  runtime: Runtime,
  flags: ReadonlyMap<string, string | true>,
  log: (message: string) => void,
  errorLog: (message: string) => void,
  m: CliMessages,
): Promise<number> {
  const applied = flags.get("applied");
  const rolledBack = flags.get("rolled-back");

  if (applied != null && rolledBack != null) {
    errorLog(m.resolveConflict);
    return 1;
  }
  if (typeof applied === "string") {
    await runtime.migrator.resolve({ migration: applied, action: "applied" });
    log(m.resolvedApplied(applied));
    return 0;
  }
  if (typeof rolledBack === "string") {
    await runtime.migrator.resolve({ migration: rolledBack, action: "rolled-back" });
    log(m.resolvedRolledBack(rolledBack));
    return 0;
  }
  errorLog(m.resolveRequired);
  return 1;
}

/** 破坏性变更的交互确认；`--force` 或非 TTY 下直接放行/拒绝 */
function makeConfirm(
  force: boolean,
  errorLog: (message: string) => void,
  m: CliMessages,
): (diff: Diff) => Promise<boolean> {
  return async (diff: Diff): Promise<boolean> => {
    if (force) {
      return true;
    }
    printDestructive(diff.destructive, errorLog, m);
    if (!process.stdin.isTTY) {
      errorLog(m.nonInteractive);
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(m.confirm)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  };
}

function printDestructive(
  changes: ReadonlyArray<DestructiveChange>,
  errorLog: (message: string) => void,
  m: CliMessages,
): void {
  errorLog(m.destructive);
  for (const change of changes) {
    switch (change.kind) {
      case "DROP_TABLE":
        errorLog(m.dropTable(change.table));
        break;
      case "DROP_COLUMN":
        errorLog(m.dropColumn(change.table, change.column));
        break;
      case "ALTER_COLUMN":
        errorLog(m.alterColumn(change.table, change.column, change.type));
        break;
    }
  }
}
