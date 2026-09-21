/**
 * CLI 配置 —— 在项目根放一个 `ts-grm-migrate.config.ts`（或 `.mts` / `.mjs` / `.js`）。
 *
 * ```ts
 * import { defineConfig } from "ts-grm-migrate";
 *
 * export default defineConfig({
 *   database: { host: "localhost", database: "app", user: "postgres" },
 *   models: ["./src/models"],   // 相对项目根，交给 EntityManager.of 加载
 * });
 * ```
 *
 * 模型文件可以是 `.ts`（Node 22.18+ / 23.6+ 原生类型剥离）或编译后的 `.js`。
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dialectInfo } from "./dialect.js";

// 方言名统一由 src/dialect.ts 定义（那里同时维护 ts-grm 驱动型号与实现状态）
export type { DialectName } from "./dialect.js";

/**
 * 数据库连接。
 *
 * - postgres：原样传给 pg 的 Pool（host / port / user / password / database / connectionString）；
 * - sqlite：用 `file` 指定库文件（相对项目根；`:memory:` 为内存库），其余字段忽略。
 */
export interface DatabaseConfig {
  /** SQL Server TLS options. Defaults: encrypt=true, trustServerCertificate=false. */
  readonly encrypt?: boolean;
  readonly trustServerCertificate?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  readonly connectionString?: string;
  /** sqlite 专用：库文件路径（相对项目根）或 ":memory:" */
  readonly file?: string;
}

export interface MigrateConfig {
  /**
   * 方言，默认 "postgres"。
   *
   * postgres / sqlite / mysql / mssql / oracle 均有实现，版本和功能边界见 README。
   *
   * sqlite 时用 `database.file` 指定库文件（相对项目根，或 ":memory:"），
   * 且**不能**配 `schema`（SQLite 没有 schema 概念，配了会报错）。
   */
  readonly dialect?: import("./dialect.js").DialectName;
  /** 数据库连接 */
  readonly database: DatabaseConfig;
  /**
   * 模型文件或目录（相对项目根，必须以 `./` 或 `../` 开头 —— `EntityManager.of` 的要求）。
   * 只用于触发模型注册；实际拿到的是全局注册表里的**全部** model。
   */
  readonly models: ReadonlyArray<string>;
  /** 迁移文件目录（相对项目根），默认 `./src/ts-grm` */
  readonly migrationsDir?: string;
  /** 目标 schema：PG 默认 public，SQL Server 默认 dbo，Oracle 默认登录用户 schema。 */
  readonly schema?: string;
  /** 进程锁文件（相对项目根），默认 `./.ts-grm-migrate.lock` */
  readonly lockPath?: string;
}

/** 配置辅助函数：仅用于类型提示与自动补全 */
export function defineConfig(config: MigrateConfig): MigrateConfig {
  return config;
}

/** 配置文件名候选（按顺序尝试） */
export const CONFIG_FILENAMES: ReadonlyArray<string> = [
  "ts-grm-migrate.config.ts",
  "ts-grm-migrate.config.mts",
  "ts-grm-migrate.config.mjs",
  "ts-grm-migrate.config.js",
];

export interface LoadedConfig {
  readonly config: MigrateConfig;
  /** 实际加载的配置文件绝对路径 */
  readonly path: string;
}

/** 加载配置：显式路径优先，否则在 `cwd` 下按候选名查找 */
export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<LoadedConfig> {
  const file =
    explicitPath != null ? path.resolve(cwd, explicitPath) : await findConfig(cwd);
  if (file == null) {
    throw new Error(
      `未找到配置文件。请在项目根创建下列之一：\n  ${CONFIG_FILENAMES.join("\n  ")}`,
    );
  }
  const exported = await importConfigModule(file);
  return { config: validateConfig(exported, file), path: file };
}

async function findConfig(cwd: string): Promise<string | null> {
  for (const name of CONFIG_FILENAMES) {
    const file = path.join(cwd, name);
    try {
      await access(file);
      return file;
    } catch {
      // 不存在就试下一个
    }
  }
  return null;
}

async function importConfigModule(file: string): Promise<unknown> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    throw new Error(`加载配置文件失败 "${file}"：${(e as Error).message}${configLoadHint(file, e)}`);
  }
  return mod.default;
}

/** 针对常见失败给出可操作的提示，而不是把 Node 的原始报错直接丢给使用者 */
function configLoadHint(file: string, error: unknown): string {
  const message = (error as Error).message ?? "";
  if (message.includes("outside a module")) {
    return (
      "\n提示：`.ts` 配置文件的模块类型由最近的 package.json 决定。" +
      "若你的项目是 CommonJS，请把配置改名为 `.mts`（强制 ESM），" +
      "或给 package.json 加上 \"type\": \"module\"。"
    );
  }
  if (message.includes("Cannot find module")) {
    return `\n提示：配置文件里 import 的包在该项目下解析不到（请确认已安装，路径：${file}）。`;
  }
  return "";
}

function validateConfig(value: unknown, file: string): MigrateConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `配置文件 "${file}" 必须默认导出一个配置对象（建议用 defineConfig(...) 包裹）。`,
    );
  }
  const config = value as Partial<MigrateConfig>;
  if (typeof config.database !== "object" || config.database === null) {
    throw new Error(`配置文件 "${file}" 缺少 database（数据库连接信息）。`);
  }
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error(
      `配置文件 "${file}" 缺少 models（模型文件或目录，至少一项）。`,
    );
  }
  // 方言先过一遍注册表：未知方言在这里就报错，"已知但未实现"留给 runtime
  // （那里的提示能带上 ts-grm 驱动名与实现进度）
  if (config.dialect != null) {
    dialectInfo(config.dialect);
  }
  return config as MigrateConfig;
}
