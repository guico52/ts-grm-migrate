/**
 * CLI 配置 —— 在项目根放一个 `ts-grm-migrate.config.ts`（或 `.mts` / `.mjs` / `.js`）。
 *
 * ```ts
 * import { defineConfig } from "@ts-grm/migrate";
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

export type DialectName = "postgres";

/** 数据库连接（原样传给 pg 的 Pool） */
export interface DatabaseConfig {
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
  readonly password?: string;
  readonly connectionString?: string;
}

export interface MigrateConfig {
  /** 方言，目前仅 "postgres" */
  readonly dialect?: DialectName;
  /** 数据库连接 */
  readonly database: DatabaseConfig;
  /**
   * 模型文件或目录（相对项目根，必须以 `./` 或 `../` 开头 —— `EntityManager.of` 的要求）。
   * 只用于触发模型注册；实际拿到的是全局注册表里的**全部** model。
   */
  readonly models: ReadonlyArray<string>;
  /** 迁移文件目录（相对项目根），默认 `./src/ts-grm` */
  readonly migrationsDir?: string;
  /** 目标 schema 名，默认 `public` */
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
    throw new Error(`加载配置文件失败 "${file}"：${(e as Error).message}`);
  }
  return mod.default;
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
  return config as MigrateConfig;
}
