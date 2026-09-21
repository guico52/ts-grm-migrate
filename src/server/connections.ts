import type { DatabaseConfig } from "../config.js";
import { SqlServerSqlExecutor } from "../executor/sqlserver.js";
import { OracleSqlExecutor } from "../executor/oracle.js";
import { ServerSql } from "./sql.js";

/**
 * mssql exposes acquire/release for pinning connections. Keep this boundary in one place.
 * A Request's parent delegates acquisition to the reserved physical session, never the pool.
 * @see https://github.com/tediousjs/node-mssql/blob/master/lib/base/connection-pool.js
 * @see https://github.com/tediousjs/node-mssql/blob/master/lib/base/transaction.js
 */
export async function openSqlServer(database: DatabaseConfig, schema: string) {
  let runtime: typeof import("mssql");
  try {
    runtime = await import("mssql");
  } catch {
    throw new Error("mssql 方言需要 mssql 依赖，请安装：yarn add mssql");
  }
  const pool = new runtime.ConnectionPool(
    database.connectionString ?? {
      server: database.host ?? "localhost",
      port: database.port ?? 1433,
      user: database.user,
      password: database.password,
      database: database.database,
      options: {
        encrypt: database.encrypt ?? true,
        trustServerCertificate: database.trustServerCertificate ?? false,
      },
      connectionTimeout: 15_000,
      requestTimeout: 30_000,
    },
  );
  pool.on("error", () => {
    /* Requests retain the original connection error. */
  });
  const pinnedPool = pool as unknown as {
    config: unknown;
    acquire(requester: unknown): Promise<unknown>;
    release(connection: unknown): void;
  };
  await pool.connect();
  let connection: unknown;
  try {
    connection = await pinnedPool.acquire(pool);
  } catch (e) {
    await pool.close();
    throw e;
  }
  const parent = {
    config: pinnedPool.config,
    connected: true,
    acquire(
      _request: unknown,
      callback: (error: null, connection: unknown, config: unknown) => void,
    ): void {
      callback(null, connection, pinnedPool.config);
    },
    release(): void {},
  };
  const session = {
    request: () => new runtime.Request(parent as never) as never,
  };
  const executor = new SqlServerSqlExecutor(session, schema);
  const close = async (): Promise<void> => {
    pinnedPool.release(connection);
    await pool.close();
  };
  try {
    const version = await executor.query(
      "select cast(serverproperty('ProductMajorVersion') as int) as version",
    );
    if (Number(version.rows[0]?.version) < 13)
      throw new Error("mssql 方言需要 SQL Server 2016+");
    const { rows } = await executor.query("select schema_id(@p1) as id", [
      schema,
    ]);
    if (rows[0]?.id == null) {
      const sql = new ServerSql("mssql", schema);
      await executor.query(
        `exec(${sql.literal(`create schema ${sql.identifier(schema)}`)})`,
      );
    }
    const canonical = await executor.query(
      "select name from sys.schemas where schema_id=schema_id(@p1)",
      [schema],
    );
    const canonicalSchema = String(canonical.rows[0]?.name ?? schema);
    return {
      executor: new SqlServerSqlExecutor(session, canonicalSchema),
      schema: canonicalSchema,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

export async function openOracle(
  database: DatabaseConfig,
  requestedSchema?: string,
) {
  let runtime: typeof import("oracledb");
  try {
    runtime = (await import("oracledb")).default;
  } catch {
    throw new Error("oracle 方言需要 oracledb 依赖，请安装：yarn add oracledb");
  }
  const connectString =
    database.connectionString ??
    `${database.host ?? "localhost"}:${database.port ?? 1521}/${database.database ?? "FREEPDB1"}`;
  const connection = await runtime.getConnection({
    user: database.user,
    password: database.password,
    connectString,
  });
  connection.callTimeout = 30_000;
  const close = async (): Promise<void> => {
    await connection.close();
  };
  try {
    if (Number(connection.oracleServerVersionString.split(".")[0]) < 19)
      throw new Error("oracle 方言需要 Oracle 19c+");
    const who = await connection.execute<{ NAME: string }>(
      "select sys_context('USERENV', 'CURRENT_SCHEMA') as name from dual",
      [],
      { outFormat: runtime.OUT_FORMAT_OBJECT },
    );
    const schema = requestedSchema ?? who.rows?.[0]?.NAME;
    if (!schema) throw new Error("无法确定 Oracle schema");
    const sql = new ServerSql("oracle", schema);
    await connection.execute(
      `alter session set current_schema=${sql.identifier(schema)}`,
    );
    await connection.execute("alter session set nls_length_semantics=BYTE");
    const executor = new OracleSqlExecutor(
      {
        execute: async (statement, binds, options) => {
          const result = await connection.execute(statement, binds as never, {
            ...options,
            fetchInfo: {
              error: { type: runtime.STRING },
              logs: { type: runtime.STRING },
            },
          });
          return result as never;
        },
      },
      schema,
    );
    return { executor, schema, close };
  } catch (e) {
    await close();
    throw e;
  }
}
