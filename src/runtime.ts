/**
 * 运行时组装 —— 从 `MigrateConfig` 造出一个可用的 `Migrator`。
 *
 * CLI 与程序化调用共用这一层，这样「命令行能用」和「脚本里能用」走的是同一条路径。
 *
 * 组装链（正是 docs/design.md 里写的那条）：
 *   EntityManager.of(cwd, ...models)   ← 触发模型注册，取回全部 entity
 *   newSqlClient(<方言>Driver(conn), { entityManager })
 *   createSchema(sqlClient)            ← 上游 API，结构在 tableDefs 上（见 vendor 层）
 *   tableDefsToSchema(..., { dialect }) ← 目标态 Schema
 *
 * 方言差异集中在 `createConnection` 与 `assembleRuntime` 的两处分支里；
 * 哪些方言可用由 `src/dialect.ts` 的注册表决定（未实现在装配前就拒掉）。
 */
import path from "node:path";
import {
  createSchema,
  EntityManager,
  newSqlClient,
  PostgresDriver,
  SqliteDriver,
  type SqlClientImplementor,
} from "./vendor/ts-grm.js";
import { PostgresDdlGenerator } from "./ddl/postgres.js";
import { SqliteDdlGenerator } from "./ddl/sqlite.js";
import { PostgresSqlExecutor } from "./executor/postgres.js";
import { SqliteSqlExecutor, type SqliteDatabaseLike } from "./executor/sqlite.js";
import { PostgresIntrospector } from "./introspector/postgres.js";
import { SqliteIntrospector } from "./introspector/sqlite.js";
import { Migrator } from "./migrator.js";
import { tableDefsToSchema } from "./schema/adapter.js";
import { DatabaseMigrationHistoryStore, FileMigrationStore } from "./store.js";
import { quoteIdentifier } from "./ddl.js";
import type { DdlGenerator, DdlGeneratorOptions } from "./ddl.js";
import type { SqlExecutor } from "./executor.js";
import type { Diff } from "./diff/types.js";
import type { Introspector } from "./introspector.js";
import type { PgPoolLike } from "./executor/postgres.js";
import type { DialectName, MigrateConfig } from "./config.js";
import { dialectInfo, IMPLEMENTED_DIALECT_NAMES } from "./dialect.js";

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
  // 方言在装配之前就定死：未实现的直接拒掉，并说清楚上游由谁提供，
  // 而不是等运行到 introspection/执行阶段才炸（见 src/dialect.ts）
  const dialect = config.dialect ?? "postgres";
  const dialectSupport = dialectInfo(dialect);
  if (!dialectSupport.implemented) {
    throw new Error(
      `方言 "${dialect}" 尚未实现（ts-grm 侧由 ${dialectSupport.tsGrmDrivers.join(" / ")} 提供）。` +
        `目前端到端可用的方言：${IMPLEMENTED_DIALECT_NAMES.join(" / ")}。`,
    );
  }

  const connection = await createConnection(dialect, config, cwd);
  try {
    return await assembleRuntime(config, cwd, options, dialect, connection);
  } catch (e) {
    // 组装途中失败必须把连接关掉：close() 只挂在成功返回的 Runtime 上，
    // 若在这里漏掉，连接会一直留在数据库里 —— 反复调用会累积到打满连接，
    // 后续操作全部挂起（实测踩过：PG 上堆积 60 个 idle 连接）。
    await connection.close().catch(() => undefined);
    throw e;
  }
}

/**
 * 方言相关的一次性装配物：连接、执行器、结构读取器、上游 driver。
 * 这三样在各方言间差异最大，集中在这里，`assembleRuntime` 只负责与方言无关的接线。
 */
interface DialectConnection {
  readonly executor: SqlExecutor;
  readonly introspector: Introspector;
  /** 交给 `newSqlClient` 的上游 driver */
  readonly driver: unknown;
  close(): Promise<void>;
}

async function createConnection(
  dialect: DialectName,
  config: MigrateConfig,
  cwd: string,
): Promise<DialectConnection> {
  if (dialect === "sqlite") {
    const database = await openSqlite(config, cwd);
    const executor = new SqliteSqlExecutor(database);
    return {
      executor,
      introspector: new SqliteIntrospector({ query: executor }),
      driver: new SqliteDriver(database as never),
      close: async () => {
        database.close();
      },
    };
  }

  // postgres（注册表已保证只有已实现的方言能走到这里）
  const pool = await createPool(config);
  const executor = new PostgresSqlExecutor(pool);
  return {
    executor,
    introspector: new PostgresIntrospector({
      query: executor,
      schema: config.schema ?? "public",
    }),
    driver: new PostgresDriver(
      pool as unknown as ConstructorParameters<typeof PostgresDriver>[0],
    ),
    close: async () => {
      await pool.end();
    },
  };
}

/** 与方言无关的接线：迁移文件、历史表、模型加载、DDL 生成器 */
async function assembleRuntime(
  config: MigrateConfig,
  cwd: string,
  options: RuntimeOptions,
  dialect: DialectName,
  connection: DialectConnection,
): Promise<Runtime> {
  const { executor, introspector, driver } = connection;
  const migrationsDir = path.resolve(cwd, config.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const lockPath = path.resolve(cwd, config.lockPath ?? DEFAULT_LOCK_PATH);
  const schema = config.schema ?? "public";

  if (dialect === "postgres") {
    // 非 public 时确保目标 schema 存在（幂等）：search_path 指向不存在的 schema
    // 会让后续每一条未限定表名的语句都失败
    if (schema !== "public") {
      await executor.executeStatements([
        `create schema if not exists ${quoteIdentifier(schema)}`,
      ]);
    }
  } else if (schema !== "public") {
    // SQLite 没有 schema 概念（只有 main / attached）。显式配了别的名字说明
    // 使用者的预期与方言不符，宁可报错也不要静默忽略。
    throw new Error(
      `方言 "${dialect}" 不支持 schema（配置里给的是 "${schema}"）。请去掉 schema 配置。`,
    );
  }

  // EntityManager.of 要求至少一个路径（AtLeastOne），配置校验已保证非空
  const entityManager = EntityManager.of(
    cwd,
    ...(config.models as [string, ...Array<string>]),
  );
  const sqlClient = newSqlClient(driver as never, { entityManager }) as unknown as SqlClientImplementor;

  // SQLite 重建表需要**目标态** TableDef 与 driver（diff 反推不出完整表结构），
  // 而它们只在 targetSchema() 里才拿得到 —— 所以把这个 options 对象交给生成器
  // 持有，在那里回填。Postgres 不需要，留空即可。
  const ddlOptions: DdlGeneratorOptions = {};
  const ddl: DdlGenerator =
    dialect === "sqlite" ? new SqliteDdlGenerator(ddlOptions) : new PostgresDdlGenerator();

  const migrator = new Migrator({
    files: new FileMigrationStore(migrationsDir),
    history: new DatabaseMigrationHistoryStore({ executor, dialect }),
    executor,
    introspector,
    ddl,
    targetSchema: async () => {
      let tableDefs;
      try {
        tableDefs = await createSchema(sqlClient);
      } catch (e) {
        throw new Error(
          `加载模型失败：${(e as Error).message}\n` +
            `提示：migrate 用 Node 原生 import 直接加载你的模型文件，所以它们必须是 ESM —— ` +
            `给项目加上 "type": "module"，或把 models 指向编译后的 ESM 产物（.js）。`,
        );
      }
      ddlOptions.tableDefs = new Map(tableDefs.map((t) => [t.name, t]));
      ddlOptions.driver = sqlClient.driver;
      return tableDefsToSchema(tableDefs, sqlClient.driver, { dialect });
    },
    migrationsDir,
    lockPath,
    ...(options.confirm != null ? { confirm: options.confirm } : {}),
  });

  return {
    migrator,
    close: () => connection.close(),
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
/**
 * 连接建立（含主机名解析）的默认上限。
 * 主机名解析偶发卡住时，pg 会无限等待；有上限才能报错而非挂死。
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

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

  const poolConfig: Record<string, unknown> = {
    // 连接建立（含主机名解析）必须有上限。主机名解析偶发卡住时（实测
    // systemd-resolved 抖动），pg 的 pool.connect() 会无限等待，
    // 表现为 CLI 静默挂死到外层超时 —— 加了上限才会快速报错。
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    ...config.database,
  };
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

/**
 * 打开 SQLite 库文件。better-sqlite3 是**可选** peer 依赖（同 pg 的处理方式）：
 * 只有 sqlite 方言才需要它，因此动态 import 并给可操作的提示。
 */
async function openSqlite(
  config: MigrateConfig,
  cwd: string,
): Promise<SqliteDatabaseLike & { close(): void }> {
  let Database: new (file: string) => SqliteDatabaseLike & { close(): void };
  try {
    const mod = (await import("better-sqlite3")) as unknown as {
      default: new (file: string) => SqliteDatabaseLike & { close(): void };
    };
    Database = mod.default;
  } catch {
    throw new Error(
      "sqlite 方言需要 better-sqlite3 依赖，请先安装：yarn add better-sqlite3",
    );
  }
  // 相对项目根解析（":memory:" 这类特殊值原样传）
  const file = config.database.file ?? ":memory:";
  return new Database(file === ":memory:" ? file : path.resolve(cwd, file));
}
