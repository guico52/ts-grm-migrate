/**
 * 测试工具包：提供配置好的 ts-grm sqlClient 对象。
 *
 * 用法：
 * ```ts
 * import { createTestSqlClient } from "./util/ts-grm-client";
 * const sqlClient = createTestSqlClient();   // 类型为 SqlClientImplementor
 * const tableDefs = await createSchema(sqlClient);
 * ```
 *
 * - 内存 SQLite 库（better-sqlite3），无需外部数据库服务；
 * - entityManager 用 EntityManager.combine 直接挂载模型对象（见 tests/model/），
 *   不经过 of() 的目录扫描加载（node import 在 vitest 下的模块缓存不可控）；
 * - 数据库在测试文件结束时自动关闭（vitest afterAll）。
 *
 * 模块实例约定：@ts-grm/* 一律走 ESM import。依赖改为 npm 包后，
 * node CJS require 与 ESM import 会得到两份 EntityManager/model/prop
 * （实测 ESM !== CJS），混用会导致 entityManager.entities 丢失、instanceof 错乱。
 */
import Database from "better-sqlite3";
import { afterAll } from "vitest";
import { Pool } from "pg";
import {
  EntityManager,
  newSqlClient,
  PostgresDriver,
  SqliteDriver,
  type SqlClientImplementor,
} from "../../src/vendor/ts-grm";
import { AUTHOR, BOOK, TAG } from "../model/model";

/**
 * 创建配置好的 sqlite 内存 sqlClient（含 entityManager）。
 * 返回类型即 createSchema 的参数类型。
 */
export function createTestSqlClient(): SqlClientImplementor {
  const database = new Database(":memory:");
  const client = newSqlClient(new SqliteDriver(database), {
    // combine 的 AtLeastTwo 恰好接受两个 part，三个实体用嵌套组合
    entityManager: EntityManager.combine(EntityManager.combine(AUTHOR, BOOK), TAG),
  });
  afterAll(() => {
    database.close();
  });
  return client as unknown as SqlClientImplementor;
}

/** Postgres 连接配置（测试用） */
export interface PgTestConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

/**
 * 创建连接远程 Postgres 的 sqlClient（含 entityManager，同 CJS 单实例约定）。
 * 调用方负责 pool.end() 收尾。
 */
export function createTestPostgresClient(config: PgTestConfig): {
  readonly sqlClient: SqlClientImplementor;
  readonly pool: Pool;
} {
  // max 调小：测试库与其他应用共用连接配额（见 vitest.config.ts 注释）
  const pool = new Pool({ ...config, max: 2 });
  // 双 @types/pg 副本（migrate 与 ts-grm 各一份）导致 Pool 类型不兼容，运行时结构一致，强转即可
  const client = newSqlClient(
    new PostgresDriver(pool as unknown as ConstructorParameters<typeof PostgresDriver>[0]),
    {
      entityManager: EntityManager.combine(EntityManager.combine(AUTHOR, BOOK), TAG),
    },
  );
  return { sqlClient: client as unknown as SqlClientImplementor, pool };
}
