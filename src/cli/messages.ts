import { CONFIG_FILENAMES } from "../config.js";

const en = {
  usage: `ts-grm-migrate — Database migrations for ts-grm

Usage: tgm <command> [options]

Commands:
  dev [-n <name>]              Generate and apply a migration
  deploy                       Apply pending migrations
  push                         Sync the database without migration history
  status                       Show migration status
  resolve --applied <id>       Mark a migration as applied
  resolve --rolled-back <id>   Mark a migration as rolled back

Options:
  -n, --name <name>            Migration name (dev)
  --config <path>              Configuration file path
  --force                      Skip destructive-change confirmation
  --detail                     Show steps, SQL and lock information
  --lang <en|zh-CN>            Output language (default: en)
  -h, --help                   Show help

Configuration files:
  ${CONFIG_FILENAMES.join("\n  ")}
`,
  invalidLanguage: (value: string) => `Unsupported language "${value}". Use en or zh-CN.`,
  invalidOption: (flag: string) => `Option --${flag} does not take a value.`,
  unknownCommand: (command: string) => `Unknown command "${command}".`,
  config: (file: string) => `Config: ${file}`,
  target: (target: string) => `Target: ${target}`,
  cancelled: "Cancelled.",
  error: "Error",
  devApplied: (id: string, target: string) => `Generated and applied migration ${id} to ${target}.`,
  devNoop: (target: string) => `${target} is up to date; no migration needed.`,
  deployApplied: (count: number, target: string) => `Applied ${count} migration${count === 1 ? "" : "s"} to ${target}.`,
  deployNoop: (target: string) => `No pending migrations for ${target}.`,
  pushApplied: (count: number, target: string) => `Synced ${target} (${count} statement${count === 1 ? "" : "s"}).`,
  pushNoop: (target: string) => `${target} is up to date; no sync needed.`,
  drift: (target: string) => `Warning: ${target} differs from the model:`,
  driftTable: (table: string, summary: string) => `  - Table ${table}: ${summary}`,
  driftHint: "Check for a partial migration or manual database changes.",
  knownDrift: (count: number) => `Ignored ${count} difference${count === 1 ? "" : "s"} that cannot be compared reliably.`,
  noMigrations: "No migrations found.",
  appliedHeading: "Applied:",
  pendingHeading: "Pending:",
  failed: "failed",
  noPending: "No pending migrations.",
  resolvedApplied: (id: string) => `Marked ${id} as applied.`,
  resolvedRolledBack: (id: string) => `Marked ${id} as rolled back.`,
  resolveConflict: "Choose only one of --applied and --rolled-back.",
  resolveRequired: "resolve requires --applied <id> or --rolled-back <id>.",
  nonInteractive: "Cannot confirm in a non-interactive session. Retry with --force after reviewing the change.",
  confirm: "Continue? (y/N) ",
  destructive: "Potentially destructive changes:",
  dropTable: (table: string) => `  - Drop table ${table}`,
  dropColumn: (table: string, column: string) => `  - Drop column ${table}.${column}`,
  alterColumn: (table: string, column: string, type: string) => `  - Alter column type ${table}.${column} → ${type}`,
  detailProcessLock: (path: string) => `Acquired process lock: ${path}`,
  detailDatabaseLock: (key: string) => `Acquired database lock: ${key}`,
  detailSql: (sql: string) => `Executing SQL:\n${sql}`,
  detailMigration: (id: string) => `Applying migration: ${id}`,
  detailApplied: (id: string) => `Applied migration: ${id}`,
  detailSkipped: (count: number) => `Skipped ${count} already applied migrations.`,
};

export type CliMessages = typeof en;

const zhCN = {
  usage: `ts-grm-migrate — ts-grm 的数据库迁移工具

用法: tgm <command> [options]

命令:
  dev [-n <name>]              生成并应用迁移
  deploy                       应用待处理迁移
  push                         同步数据库，不记录迁移历史
  status                       查看迁移状态
  resolve --applied <id>       标记迁移已应用
  resolve --rolled-back <id>   标记迁移已回滚

选项:
  -n, --name <name>            迁移名（dev）
  --config <path>              配置文件路径
  --force                      跳过破坏性变更确认
  --detail                     显示执行步骤、SQL 和锁信息
  --lang <en|zh-CN>            输出语言（默认 en）
  -h, --help                   显示帮助

配置文件:
  ${CONFIG_FILENAMES.join("\n  ")}
`,
  invalidLanguage: (value: string) => `不支持语言 "${value}"。请使用 en 或 zh-CN。`,
  invalidOption: (flag: string) => `选项 --${flag} 不需要参数。`,
  unknownCommand: (command: string) => `未知命令 "${command}"。`,
  config: (file: string) => `配置：${file}`,
  target: (target: string) => `目标：${target}`,
  cancelled: "已取消。",
  error: "错误",
  devApplied: (id: string, target: string) => `已在 ${target} 生成并应用迁移 ${id}。`,
  devNoop: (target: string) => `${target} 已是最新，无需迁移。`,
  deployApplied: (count: number, target: string) => `已在 ${target} 应用 ${count} 个迁移。`,
  deployNoop: (target: string) => `${target} 没有待应用的迁移。`,
  pushApplied: (count: number, target: string) => `已同步 ${target}（${count} 条语句）。`,
  pushNoop: (target: string) => `${target} 已是最新，无需同步。`,
  drift: (target: string) => `警告：${target} 与模型不一致：`,
  driftTable: (table: string, summary: string) => `  - 表 ${table}：${summary}`,
  driftHint: "请检查迁移是否完整执行，或数据库是否被手工修改。",
  knownDrift: (count: number) => `另有 ${count} 处差异因已知限制无法比对，已忽略。`,
  noMigrations: "没有任何迁移。",
  appliedHeading: "已应用：",
  pendingHeading: "待应用：",
  failed: "失败",
  noPending: "没有待应用的迁移。",
  resolvedApplied: (id: string) => `已标记为已应用：${id}`,
  resolvedRolledBack: (id: string) => `已标记回滚：${id}`,
  resolveConflict: "--applied 与 --rolled-back 只能选一个。",
  resolveRequired: "resolve 需要 --applied <id> 或 --rolled-back <id>。",
  nonInteractive: "当前不是交互环境；确认后请加 --force 重试。",
  confirm: "是否继续？(y/N) ",
  destructive: "检测到可能丢失数据的变更：",
  dropTable: (table: string) => `  - 删除表 ${table}`,
  dropColumn: (table: string, column: string) => `  - 删除列 ${table}.${column}`,
  alterColumn: (table: string, column: string, type: string) => `  - 修改列类型 ${table}.${column} → ${type}`,
  detailProcessLock: (path: string) => `已获取进程锁：${path}`,
  detailDatabaseLock: (key: string) => `已获取数据库锁：${key}`,
  detailSql: (sql: string) => `执行 SQL:\n${sql}`,
  detailMigration: (id: string) => `正在应用迁移：${id}`,
  detailApplied: (id: string) => `已应用迁移：${id}`,
  detailSkipped: (count: number) => `跳过 ${count} 个已应用迁移。`,
} satisfies CliMessages;

const CATALOG = { en, "zh-CN": zhCN } satisfies Record<string, CliMessages>;

export type CliLanguage = keyof typeof CATALOG;

export function messages(language: CliLanguage): CliMessages {
  return CATALOG[language];
}
