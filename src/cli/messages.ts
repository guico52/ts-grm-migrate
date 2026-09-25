import { CONFIG_FILENAMES } from "../config.js";

export type CliLanguage = "en" | "zh-CN";

export function messages(language: CliLanguage) {
  const zh = language === "zh-CN";
  return {
    usage: `ts-grm-migrate — ${zh ? "ts-grm 的数据库迁移工具" : "Database migrations for ts-grm"}

${zh ? "用法" : "Usage"}: tgm <command> [options]

${zh ? "命令" : "Commands"}:
  dev [-n <name>]              ${zh ? "生成并应用迁移" : "Generate and apply a migration"}
  deploy                       ${zh ? "应用待处理迁移" : "Apply pending migrations"}
  push                         ${zh ? "同步数据库，不记录迁移历史" : "Sync the database without migration history"}
  status                       ${zh ? "查看迁移状态" : "Show migration status"}
  resolve --applied <id>       ${zh ? "标记迁移已应用" : "Mark a migration as applied"}
  resolve --rolled-back <id>   ${zh ? "标记迁移已回滚" : "Mark a migration as rolled back"}

${zh ? "选项" : "Options"}:
  -n, --name <name>            ${zh ? "迁移名（dev）" : "Migration name (dev)"}
  --config <path>              ${zh ? "配置文件路径" : "Configuration file path"}
  --force                      ${zh ? "跳过破坏性变更确认" : "Skip destructive-change confirmation"}
  --detail                     ${zh ? "显示执行步骤、SQL 和锁信息" : "Show steps, SQL and lock information"}
  --lang <en|zh-CN>            ${zh ? "输出语言（默认 en）" : "Output language (default: en)"}
  -h, --help                   ${zh ? "显示帮助" : "Show help"}

${zh ? "配置文件" : "Configuration files"}:
  ${CONFIG_FILENAMES.join("\n  ")}
`,
    invalidLanguage: (value: string) => zh
      ? `不支持语言 "${value}"。请使用 en 或 zh-CN。`
      : `Unsupported language "${value}". Use en or zh-CN.`,
    invalidOption: (flag: string) => zh ? `选项 --${flag} 不需要参数。` : `Option --${flag} does not take a value.`,
    unknownCommand: (command: string) => zh ? `未知命令 "${command}"。` : `Unknown command "${command}".`,
    config: (file: string) => zh ? `配置：${file}` : `Config: ${file}`,
    target: (target: string) => zh ? `目标：${target}` : `Target: ${target}`,
    cancelled: zh ? "已取消。" : "Cancelled.",
    error: zh ? "错误" : "Error",
    devApplied: (id: string, target: string) => zh
      ? `已在 ${target} 生成并应用迁移 ${id}。`
      : `Generated and applied migration ${id} to ${target}.`,
    devNoop: (target: string) => zh ? `${target} 已是最新，无需迁移。` : `${target} is up to date; no migration needed.`,
    deployApplied: (count: number, target: string) => zh
      ? `已在 ${target} 应用 ${count} 个迁移。`
      : `Applied ${count} migration${count === 1 ? "" : "s"} to ${target}.`,
    deployNoop: (target: string) => zh ? `${target} 没有待应用的迁移。` : `No pending migrations for ${target}.`,
    pushApplied: (count: number, target: string) => zh
      ? `已同步 ${target}（${count} 条语句）。`
      : `Synced ${target} (${count} statement${count === 1 ? "" : "s"}).`,
    pushNoop: (target: string) => zh ? `${target} 已是最新，无需同步。` : `${target} is up to date; no sync needed.`,
    drift: (target: string) => zh ? `警告：${target} 与模型不一致：` : `Warning: ${target} differs from the model:`,
    driftTable: (table: string, summary: string) => zh ? `  - 表 ${table}：${summary}` : `  - Table ${table}: ${summary}`,
    driftHint: zh ? "请检查迁移是否完整执行，或数据库是否被手工修改。" : "Check for a partial migration or manual database changes.",
    knownDrift: (count: number) => zh
      ? `另有 ${count} 处差异因已知限制无法比对，已忽略。`
      : `Ignored ${count} difference${count === 1 ? "" : "s"} that cannot be compared reliably.`,
    noMigrations: zh ? "没有任何迁移。" : "No migrations found.",
    appliedHeading: zh ? "已应用：" : "Applied:",
    pendingHeading: zh ? "待应用：" : "Pending:",
    failed: zh ? "失败" : "failed",
    noPending: zh ? "没有待应用的迁移。" : "No pending migrations.",
    resolvedApplied: (id: string) => zh ? `已标记为已应用：${id}` : `Marked ${id} as applied.`,
    resolvedRolledBack: (id: string) => zh ? `已标记回滚：${id}` : `Marked ${id} as rolled back.`,
    resolveConflict: zh ? "--applied 与 --rolled-back 只能选一个。" : "Choose only one of --applied and --rolled-back.",
    resolveRequired: zh
      ? "resolve 需要 --applied <id> 或 --rolled-back <id>。"
      : "resolve requires --applied <id> or --rolled-back <id>.",
    nonInteractive: zh
      ? "当前不是交互环境；确认后请加 --force 重试。"
      : "Cannot confirm in a non-interactive session. Retry with --force after reviewing the change.",
    confirm: zh ? "是否继续？(y/N) " : "Continue? (y/N) ",
    destructive: zh ? "检测到可能丢失数据的变更：" : "Potentially destructive changes:",
    dropTable: (table: string) => zh ? `  - 删除表 ${table}` : `  - Drop table ${table}`,
    dropColumn: (table: string, column: string) => zh ? `  - 删除列 ${table}.${column}` : `  - Drop column ${table}.${column}`,
    alterColumn: (table: string, column: string, type: string) => zh
      ? `  - 修改列类型 ${table}.${column} → ${type}`
      : `  - Alter column type ${table}.${column} → ${type}`,
    detailProcessLock: (path: string) => zh ? `已获取进程锁：${path}` : `Acquired process lock: ${path}`,
    detailDatabaseLock: (key: string) => zh ? `已获取数据库锁：${key}` : `Acquired database lock: ${key}`,
    detailSql: (sql: string) => zh ? `执行 SQL:\n${sql}` : `Executing SQL:\n${sql}`,
    detailMigration: (id: string) => zh ? `正在应用迁移：${id}` : `Applying migration: ${id}`,
    detailApplied: (id: string) => zh ? `已应用迁移：${id}` : `Applied migration: ${id}`,
    detailSkipped: (count: number) => zh ? `跳过 ${count} 个已应用迁移。` : `Skipped ${count} already applied migrations.`,
  };
}

export type CliMessages = ReturnType<typeof messages>;
