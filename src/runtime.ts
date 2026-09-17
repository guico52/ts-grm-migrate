/**
 * 运行时组装 —— 从 `MigrateConfig` 造出一个可用的 `Migrator`。
 *
 * CLI 与程序化调用共用这一层，这样「命令行能用」和「脚本里能用」走的是同一条路径。
 *
 * 组装链（正是 docs/design.md 里写的那条）：
 *   EntityManager.of(cwd, ...models)   ← 触发模型注册，取回全部 entity
 *   newSqlClient(PostgresDriver(pool), { entityManager })
 *   createSchema(sqlClient)            ← 上游 API，结构在 tableDefs 上（见 vendor 层）
 *   tableDefsToSchema(...)             ← 目标态 Schema
 */
import path from "node:path";
import {
  createSchema,
  EntityManager,
  newSqlClient,
  PostgresDriver,
  type SqlClientImplementor,
} from "./vendor/ts-grm.js";
import { PostgresDdlGenerator } from "./ddl/postgres.js";
import { PostgresSqlExecutor } from "./executor/postgres.js";
import { PostgresIntrospector } from "./introspector/postgres.js";
import { Migrator } from "./migrator.js";
import { tableDefsToSchema } from "./schema/adapter.js";
import { DatabaseMigrationHistoryStore, FileMigrationStore } from "./store.js";
import { quoteIdentifier } from "./ddl.js";
import type { MigrateConfig } from "./config.js";
import type { Diff } from "./diff/types.js";
import type { PgPoolLike } from "./executor/postgres.js";

export interface Runtime {
  readonly migrator: Migrator;
  /** 释放连接池等资源 */
  close(): Promise<void>;
}

export interface RuntimeOptions {
  /**
   * 破坏性变更确认钩子（CLI 传交互式确认）。
   * 不传 = 总是允许（CI / 程序化调用，「我知道在做什么」的默认）。
   */
  readonly confirm?: (diff: Diff) => Promise<boolean>;
}

/** 默认迁移目录 / 锁文件（相对项目根） */
export const DEFAULT_MIGRATIONS_DIR = "./src/ts-grm";
export const DEFAULT_LOCK_PATH = "./.ts-grm-migrate.lock";

/**
 * 从配置组装运行时。
 *
 * `cwd` 是项目根：模型路径、迁移目录、锁文件都相对它解析。
 */
export async function createRuntime(
  config: MigrateConfig,
  cwd: string,
  options: RuntimeOptions = {},
): Promise<Runtime> {
  const dialect = config.dialect ?? "postgres";
  if (dialect !== "postgres") {
    throw new Error(`暂不支持的方言 "${dialect}"（目前只有 postgres）。`);
  }

  const pool = await createPool(config);
  try {
    return await assembleRuntime(config, cwd, options, pool);
  } catch (e) {
    // 组装途中失败必须把连接池关掉：close() 只挂在成功返回的 Runtime 上，
    // 若在这里漏掉，连接会一直留在数据库里 —— 反复调用会累积到打满连接，
    // 后续操作全部挂起（实测踩过：库里堆积 60 个 idle 连接）。
    await pool.end().catch(() => undefined);
    throw e;
  }
}

/** 用已建好的连接池组装运行时（失败时由调用方负责关池） */
async function assembleRuntime(
  config: MigrateConfig,
  cwd: string,
  options: RuntimeOptions,
  pool: ManagedPool,
): Promise<Runtime> {
  const executor = new PostgresSqlExecutor(pool);
  const schema = config.schema ?? "public";
  const migrationsDir = path.resolve(cwd, config.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const lockPath = path.resolve(cwd, config.lockPath ?? DEFAULT_LOCK_PATH);

  // 非 public 时确保目标 schema 存在（幂等）：search_path 指向不存在的 schema
  // 会让后续每一条未限定表名的语句都失败
  if (schema !== "public") {
    await executor.executeStatements([
      `create schema if not exists ${quoteIdentifier(schema)}`,
    ]);
  }

  // 模型：of() 会 import 指定路径触发注册，随后取回全局注册表里的全部 entity
  // EntityManager.of 要求至少一个路径（AtLeastOne），配置校验已保证非空
  const entityManager = EntityManager.of(
    cwd,
    ...(config.models as [string, ...Array<string>]),
  );
  const sqlClient = newSqlClient(
    new PostgresDriver(pool as unknown as ConstructorParameters<typeof PostgresDriver>[0]),
    { entityManager },
  ) as unknown as SqlClientImplementor;

  const migrator = new Migrator({
    files: new FileMigrationStore(migrationsDir),
    history: new DatabaseMigrationHistoryStore({ executor }),
    executor,
    introspector: new PostgresIntrospector({ query: executor, schema }),
    ddl: new PostgresDdlGenerator(),
    targetSchema: async () => {
      const tableDefs = await createSchema(sqlClient);
      return tableDefsToSchema(tableDefs, sqlClient.driver);
    },
    migrationsDir,
    lockPath,
    ...(options.confirm != null ? { confirm: options.confirm } : {}),
  });

  return {
    migrator,
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/** 连接池：查询 / 借连接 + 释放 */
interface ManagedPool extends PgPoolLike {
  end(): Promise<void>;
}

/**
 * 建连接池。pg 是**可选** peer 依赖：只有 postgres 方言才需要它，
 * 因此放在这里动态 import，缺失时给可操作的提示而不是模块解析崩溃。
 */
async function createPool(config: MigrateConfig): Promise<ManagedPool> {
  let Pool: new (config: unknown) => ManagedPool;
  try {
    const pg = (await import("pg")) as unknown as {
      Pool: new (config: unknown) => ManagedPool;
    };
    Pool = pg.Pool;
  } catch {
    throw new Error(
      "postgres 方言需要 pg 依赖，请先安装：yarn add pg（或 npm install pg）",
    );
  }

  const poolConfig: Record<string, unknown> = { ...config.database };
  const schema = config.schema;
  if (schema != null && schema !== "public") {
    // 让整个会话默认落在目标 schema。迁移 SQL 不带 schema 前缀，
    // 因此只把 schema 告诉 introspector 而不作用于执行侧，会导致
    // 「读 A schema、写 B schema」（实测踩过）。
    const existing = typeof poolConfig["options"] === "string" ? `${poolConfig["options"]} ` : "";
    poolConfig["options"] = `${existing}-c search_path=${schema}`;
  }
  return new Pool(poolConfig);
}
