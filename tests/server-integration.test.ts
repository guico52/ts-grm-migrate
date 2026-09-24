import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import oracledb from "oracledb";
import { openOracle, openSqlServer } from "../src/server/connections";
import { ServerSql } from "../src/server/sql";
import { ServerMigrationHistoryStore } from "../src/server/history";
import { SqlServerIntrospector } from "../src/introspector/sqlserver";
import { OracleIntrospector } from "../src/introspector/oracle";
import { normalizeServerExpression } from "../src/server/catalog";
import { ServerDdlGenerator } from "../src/server/ddl";
import { SchemaDiffer } from "../src/differ";
import { Migrator } from "../src/migrator";
import { FileMigrationStore, checksumOf } from "../src/store";
import { createRuntime } from "../src/runtime";
import { run } from "../src/cli";
import type { Column, Schema, Table } from "../src/schema/model";
import type { DatabaseConfig } from "../src/config";
import type { SqlExecutor } from "../src/executor";
import type { Introspector } from "../src/introspector";

for (const dialect of ["mssql", "oracle"] as const) {
  const prefix = dialect === "mssql" ? "MSSQL" : "ORACLE";
  describe
    .skipIf(!process.env[`${prefix}_HOST`])
    .sequential(`${dialect} 真实数据库`, () => {
      let schema: string, dir: string, database: DatabaseConfig;
      let executor: SqlExecutor,
        introspector: Introspector,
        ddl: ServerDdlGenerator,
        sql: ServerSql;
      let close: () => Promise<void>;
      let admin: oracledb.Connection | undefined;
      beforeEach(async () => {
        schema = `TGM_${randomBytes(6).toString("hex").toUpperCase()}`;
        dir = await mkdtemp(path.join(tmpdir(), "tgm-server-"));
        const host = process.env[`${prefix}_HOST`]!;
        const password = process.env[`${prefix}_PASSWORD`]!;
        if (dialect === "mssql") {
          database = {
            host,
            port: Number(process.env.MSSQL_PORT ?? 1433),
            user: process.env.MSSQL_USER ?? "sa",
            password,
            database: process.env.MSSQL_DATABASE ?? "master",
            encrypt: false,
            trustServerCertificate: true,
          };
          const connection = await openSqlServer(database, schema);
          executor = connection.executor;
          close = connection.close;
          introspector = new SqlServerIntrospector({ query: executor, schema });
        } else {
          const connectString = `${host}:${process.env.ORACLE_PORT ?? 1521}/${process.env.ORACLE_DATABASE ?? "FREEPDB1"}`;
          admin = await oracledb.getConnection({
            user: "system",
            password,
            connectString,
          });
          await admin.execute(
            `create user "${schema}" identified by "${password}" quota unlimited on users`,
          );
          await admin.execute(
            `grant create session, create table, create sequence to "${schema}"`,
          );
          await admin.execute(`grant execute on sys.dbms_lock to "${schema}"`);
          database = {
            connectionString: connectString,
            user: schema,
            password,
          };
          const connection = await openOracle(database, schema);
          executor = connection.executor;
          close = connection.close;
          introspector = new OracleIntrospector({ query: executor, schema });
        }
        sql = new ServerSql(dialect, schema);
        ddl = new ServerDdlGenerator(dialect, schema);
      });
      afterEach(async () => {
        if (dialect === "mssql" && executor) {
          // Cleanup is restricted to the randomly created schema of this test.
          const { rows: fks } = await executor.query(
            "select t.name as t,f.name as f from sys.foreign_keys f join sys.tables t on f.parent_object_id=t.object_id join sys.schemas s on s.schema_id=t.schema_id where s.name=@p1",
            [schema],
          );
          for (const row of fks)
            await executor.query(
              `alter table ${sql.table(String(row.t))} drop constraint ${sql.identifier(String(row.f))}`,
            );
          const { rows } = await executor.query(
            "select t.name from sys.tables t join sys.schemas s on s.schema_id=t.schema_id where s.name=@p1",
            [schema],
          );
          for (const row of rows)
            await executor.query(`drop table ${sql.table(String(row.name))}`);
          await executor.query(`drop schema ${sql.identifier(schema)}`);
        }
        if (close) await close();
        if (admin) {
          await admin.execute(`drop user "${schema}" cascade`);
          await admin.close();
          admin = undefined;
        }
        if (dir) await rm(dir, { recursive: true, force: true });
      });
      const col = (name: string, type?: string, nullable = false): Column => ({
        name,
        type: type ?? (dialect === "mssql" ? "int" : "number(10)"),
        nullable,
        default: undefined,
        autoIncrement: false,
        ordinal: 1,
        comment: undefined,
        length: undefined,
      });
      const table = (
        name: string,
        columns: ReadonlyArray<Column> = [col("ID")],
      ): Table => ({
        name,
        columns,
        constraints: [
          {
            kind: "PRIMARY_KEY",
            name: `${name}_PK`,
            columns: ["ID"],
            implicit: undefined,
          },
        ],
        indexes: [],
      });
      const migrate = async (target: Schema): Promise<void> => {
        const from = await introspector.introspect();
        const diff = new SchemaDiffer().diff(from, target);
        await executor.executeStatements(
          ddl.statements(diff, { from, to: target }),
        );
      };

      it("history failure rolls back transactional DDL and blocks implicit-commit replay", async () => {
        const history = new ServerMigrationHistoryStore(executor, sql);
        const files = new FileMigrationStore(dir);
        const migrationSql = `create table ${sql.table("HISTORY_FAILURE")} (${sql.identifier("ID")} ${dialect === "mssql" ? "int" : "number"})`;
        await files.write({ id: "failure", sortKey: "failure", sql: migrationSql, checksum: checksumOf(migrationSql) });
        const migrator = new Migrator({ executor, history, files, introspector, ddl, targetSchema: () => introspector.introspect(), migrationsDir: dir, lockPath: path.join(dir, "lock") });
        const record = history.recordApplied.bind(history);
        const fail = vi.spyOn(history, "recordApplied").mockImplementation(async (file, connection) => {
          if (dialect === "mssql") await record(file, connection);
          throw new Error("history unavailable");
        });
        await expect(migrator.deploy()).rejects.toThrow("history unavailable");
        fail.mockRestore();
        expect((await history.listApplied())[0]?.failed).toBe(true);
        await expect(migrator.deploy()).rejects.toThrow(/失败/);
        const tables = (await introspector.introspect()).tables.map(t => t.name);
        expect(tables.includes("HISTORY_FAILURE")).toBe(dialect === "oracle");
        await migrator.resolve({ migration: "failure", action: dialect === "oracle" ? "applied" : "rolled-back" });
        await migrator.deploy();
        expect((await history.listApplied())[0]?.failed).toBe(false);
      });

      it("runtime dev、deploy、status、CLI 与模型闭环无重复差异", async () => {
        const config = {
          dialect,
          database,
          schema,
          models: ["./tests/model/model.ts", "./tests/model/server-types.ts"],
          migrationsDir: path.join(dir, "migrations"),
          lockPath: path.join(dir, "lock"),
        };
        const runtime = await createRuntime(config, process.cwd());
        try {
          expect(await runtime.migrator.status()).toEqual({ applied: [], pending: [] });
          const result = await runtime.migrator.dev({ name: "init" });
          expect(result.applied).toBe(true);
          expect(result.drift).toEqual([]);
          expect((await runtime.migrator.dev({})).applied).toBe(false);
          expect((await runtime.migrator.deploy()).applied).toEqual([]);
          expect((await runtime.migrator.status()).applied).toHaveLength(1);
        } finally {
          await runtime.close();
        }
        // Reapply the generated SQL to an empty schema, independent of the dev execution.
        await migrate({ tables: [] });
        const deployed = await createRuntime(config, process.cwd());
        try {
          expect((await deployed.migrator.deploy()).applied).toHaveLength(1);
          expect(await deployed.migrator.checkDrift()).toEqual([]);
          const files = new FileMigrationStore(config.migrationsDir);
          const file = (await files.listFiles())[0]!;
          await writeFile(path.join(config.migrationsDir, `${file.id}.sql`), `${file.sql}\n-- tampered`);
          await expect(deployed.migrator.deploy()).rejects.toThrow(/checksum/);
          await writeFile(path.join(config.migrationsDir, `${file.id}.sql`), file.sql);
        } finally {
          await deployed.close();
        }
        const configPath = path.join(dir, "config.mjs");
        await writeFile(configPath, `export default ${JSON.stringify(config)}`);
        const errors: string[] = [];
        expect(
          await run(
            ["push", "--force", "--config", configPath],
            process.cwd(),
            { log: () => {}, errorLog: (s) => errors.push(s) },
          ),
        ).toBe(0);
        expect(errors).toEqual([]);
      });

      it("循环外键、修改双方列类型后保留数据、再删除整个依赖图", async () => {
        const a = table("A", [col("ID"), col("B_ID", undefined, true)]);
        const b = table("B", [col("ID"), col("A_ID", undefined, true)]);
        const fk = (name: string, column: string, ref: string) => ({
          kind: "FOREIGN_KEY" as const,
          name,
          columns: [column],
          referencedTable: ref,
          referencedColumns: ["ID"],
          onDelete: "NO_ACTION" as const,
          cascade: "NONE" as const,
          deferrable: false,
          implicit: undefined,
        });
        const target: Schema = {
          tables: [
            { ...b, constraints: [...b.constraints, fk("B_A", "A_ID", "A")] },
            { ...a, constraints: [...a.constraints, fk("A_B", "B_ID", "B")] },
          ],
        };
        await migrate(target);
        await executor.query(
          `insert into ${sql.table("A")} (${sql.identifier("ID")}) values (1)`,
        );
        await executor.query(
          `insert into ${sql.table("B")} (${sql.identifier("ID")},${sql.identifier("A_ID")}) values (2,1)`,
        );
        const next = {
          tables: target.tables.map((t) => ({
            ...t,
            columns: t.columns.map((c) => ({
              ...c,
              type: dialect === "mssql" ? "bigint" : "number(19)",
            })),
          })),
        };
        await migrate(next);
        expect(
          new SchemaDiffer().diff(await introspector.introspect(), next)
            .changes,
        ).toEqual([]);
        expect(
          (
            await executor.query(
              `select count(*) as ${sql.identifier("n")} from ${sql.table("B")}`,
            )
          ).rows[0]?.n,
        ).toBe(1);
        await migrate({ tables: [] });
        expect((await introspector.introspect()).tables).toEqual([]);
      });

      it("默认值含分号和单引号，修改列保留默认值，删除列处理约束", async () => {
        const text = dialect === "mssql" ? "nvarchar(50)" : "varchar2(50)";
        const t = table("WORDS", [
          col("ID"),
          { ...col("VALUE", text), default: "'it''s;ok'" },
        ]);
        await migrate({ tables: [t] });
        const before = await introspector.introspect();
        const next = {
          tables: before.tables.map((t) => ({
            ...t,
            columns: t.columns.map((c) =>
              c.name === "VALUE"
                ? { ...c, type: text.replace("50", "100"), nullable: true }
                : c,
            ),
          })),
        };
        await migrate(next);
        await executor.query(
          `insert into ${sql.table("WORDS")} (${sql.identifier("ID")}) values (1)`,
        );
        expect(
          (
            await executor.query(
              `select ${sql.identifier("VALUE")} from ${sql.table("WORDS")}`,
            )
          ).rows[0]?.VALUE,
        ).toBe("it's;ok");
        await migrate({ tables: [table("WORDS")] });
        expect(
          (await introspector.introspect()).tables[0]?.columns.map(
            (c) => c.name,
          ),
        ).toEqual(["ID"]);
      });

      it("CHECK、唯一约束与索引修改后再次比较为空", async () => {
        const base = table("RULES", [col("ID"), col("AGE"), col("CODE")]);
        const expression = `${sql.identifier("AGE")} >= 0`;
        const target: Schema = {
          tables: [
            {
              ...base,
              constraints: [
                ...base.constraints,
                {
                  kind: "CHECK",
                  name: "AGE_POSITIVE",
                  expression,
                  comparisonExpression: normalizeServerExpression(expression),
                  values: [],
                  implicit: undefined,
                },
                {
                  kind: "UNIQUE",
                  name: "CODE_UQ",
                  columns: ["CODE"],
                  implicit: undefined,
                },
              ],
              indexes: [
                {
                  name: "AGE_IDX",
                  columns: ["AGE"],
                  unique: false,
                  predicate: undefined,
                },
              ],
            },
          ],
        };
        await migrate(target);
        expect(
          new SchemaDiffer().diff(await introspector.introspect(), target)
            .changes,
        ).toEqual([]);
        const next = {
          tables: target.tables.map((t) => ({
            ...t,
            columns: t.columns.map((c) => ({
              ...c,
              type: dialect === "mssql" ? "bigint" : "number(19)",
            })),
          })),
        };
        await migrate(next);
        expect(
          new SchemaDiffer().diff(await introspector.introspect(), next)
            .changes,
        ).toEqual([]);
        await expect(
          executor.query(`insert into ${sql.table("RULES")} values (1,-1,1)`),
        ).rejects.toThrow();
      });

      it("删除默认值幂等并保留 identity", async () => {
        const t = table("DEFAULTS", [
          { ...col("ID"), autoIncrement: true },
          { ...col("VALUE", undefined, true), default: "7" },
        ]);
        await migrate({ tables: [t] });
        const actual = await introspector.introspect();
        expect(actual.tables[0]?.columns[0]?.autoIncrement).toBe(true);
        const target = {
          tables: actual.tables.map((t) => ({
            ...t,
            columns: t.columns.map((c) =>
              c.name === "VALUE" ? { ...c, default: "" } : c,
            ),
          })),
        };
        await migrate(target);
        expect(
          new SchemaDiffer().diff(await introspector.introspect(), target)
            .changes,
        ).toEqual([]);
        await executor.query(
          `insert into ${sql.table("DEFAULTS")} (${sql.identifier("VALUE")}) values (3)`,
        );
        expect(
          (
            await executor.query(
              `select ${sql.identifier("ID")} from ${sql.table("DEFAULTS")}`,
            )
          ).rows[0]?.ID,
        ).toBe(1);
      });

      it("同一 schema 的不同本地路径使用同一把锁，释放后可以继续", async () => {
        const other =
          dialect === "mssql"
            ? await openSqlServer(database, schema.toLowerCase())
            : await openOracle(database, schema);
        const release = await executor.acquireMigrationLock("/one/project");
        try {
          await expect(
            other.executor.acquireMigrationLock("/another/project"),
          ).rejects.toThrow(/lock|迁移锁/i);
          await release();
          const unlock =
            await other.executor.acquireMigrationLock("/another/project");
          await unlock();
          await unlock();
        } finally {
          await release();
          await other.close();
        }
      });

      it("失败迁移记录真实提交语义，resolve 后再次失败仍阻止部署", async () => {
        const files = new FileMigrationStore(path.join(dir, "migrations"));
        const history = new ServerMigrationHistoryStore(executor, sql);
        const migrator = new Migrator({
          executor,
          files,
          history,
          introspector,
          ddl,
          targetSchema: async () => ({ tables: [] }),
          migrationsDir: path.join(dir, "migrations"),
          lockPath: path.join(dir, "lock"),
        });
        const content = `${ddl.createStatements({ tables: [table("PARTIAL")] }).join(";\n")};\ninsert into ${sql.table("MISSING")} values(1);`;
        await files.write({
          id: "001_broken",
          sortKey: "001_broken",
          sql: content,
          checksum: checksumOf(content),
        });
        await expect(migrator.deploy()).rejects.toThrow(/执行失败/);
        const applied = await history.listApplied();
        expect(applied[0]?.failed).toBe(true);
        expect(applied[0]?.logs).toContain(
          dialect === "mssql" ? "事务已回滚" : "隐式提交",
        );
        expect(
          (await introspector.introspect()).tables.some(
            (t) => t.name === "PARTIAL",
          ),
        ).toBe(dialect === "oracle");
        await expect(migrator.deploy()).rejects.toThrow(/上次执行失败/);
        await migrator.resolve({
          migration: "001_broken",
          action: "rolled-back",
        });
        expect((await migrator.status()).pending).toEqual(["001_broken"]);
        await expect(migrator.deploy()).rejects.toThrow(/执行失败/);
        await expect(migrator.deploy()).rejects.toThrow(/上次执行失败/);
        await migrator.resolve({ migration: "001_broken", action: "applied" });
        expect((await history.listApplied())[0]?.failed).toBe(false);
      });
    });
}
