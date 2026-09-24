import type { SqlQueryable } from "../sql.js";
import type { SqlExecutor } from "../executor.js";
import type {
  AppliedMigration,
  MigrationFile,
  MigrationHistoryStore,
} from "../store.js";
import { ServerSql } from "./sql.js";

/** Named columns are deliberately quoted consistently on Oracle (case-sensitive catalog names). */
export class ServerMigrationHistoryStore implements MigrationHistoryStore {
  constructor(
    private readonly executor: SqlExecutor,
    private readonly sql: ServerSql,
    readonly tableName = "_migrations",
  ) {}
  private get table(): string {
    return this.sql.table(this.tableName);
  }
  private get now(): string {
    return this.sql.dialect === "mssql"
      ? "sysutcdatetime()"
      : "sys_extract_utc(systimestamp)";
  }
  private column(name: string): string {
    return this.sql.identifier(name);
  }

  async ensureTable(): Promise<void> {
    const exists =
      this.sql.dialect === "mssql"
        ? await this.executor.query(
            "select 1 as found from sys.tables t join sys.schemas s on s.schema_id=t.schema_id where s.name=@p1 and t.name=@p2",
            [this.sql.schema, this.tableName],
          )
        : await this.executor.query(
            'select 1 as "found" from all_tables where owner=:1 and table_name=:2',
            [this.sql.schema, this.tableName],
          );
    if (exists.rows.length) return;
    const text = this.sql.dialect === "mssql" ? "nvarchar(max)" : "clob";
    const timestamp = this.sql.dialect === "mssql" ? "datetime2" : "timestamp";
    const id =
      this.sql.dialect === "mssql"
        ? "nvarchar(255) collate Latin1_General_100_BIN2"
        : "varchar2(255 char)";
    const columns = [
      `${this.column("id")} ${id} primary key`,
      `${this.column("checksum")} varchar(64) not null`,
      `${this.column("applied_at")} ${timestamp} default ${this.now} not null`,
      `${this.column("rolled_back_at")} ${timestamp}`,
      `${this.column("failed")} ${this.sql.dialect === "mssql" ? "bit" : "number(1)"} default 0 not null`,
      `${this.column("error")} ${text}`,
      `${this.column("logs")} ${text}`,
    ];
    await this.executor.executeStatements([
      `create table ${this.table} (${columns.join(", ")})`,
    ]);
  }

  async listApplied(): Promise<ReadonlyArray<AppliedMigration>> {
    const columns = [
      "id",
      "checksum",
      "applied_at",
      "rolled_back_at",
      "failed",
      "error",
      "logs",
    ];
    let rows: ReadonlyArray<Record<string, unknown>>;
    try {
      ({ rows } = await this.executor.query(
        `select ${columns.map((c) => this.column(c)).join(", ")} from ${this.table} order by ${this.column("applied_at")}, ${this.column("id")}`,
      ));
    } catch (error) {
      const e = error as { number?: number; errorNum?: number };
      if (this.sql.dialect === "mssql" && e.number === 208) return [];
      if (this.sql.dialect === "oracle" && e.errorNum === 942) {
        // ORA-00942 also means lack of access to another user's table. Only the
        // owner's catalog can prove absence; otherwise retain the original error.
        const { rows: owner } = await this.executor.query(
          `select sys_context('USERENV', 'SESSION_USER') as "owner" from dual`,
        );
        if (owner[0]?.owner === this.sql.schema) {
          const { rows: tables } = await this.executor.query(
            'select table_name from user_tables where table_name=:1', [this.tableName],
          );
          if (!tables.length) return [];
        }
      }
      throw error;
    }
    return rows.map((r) => ({
      id: String(r.id),
      checksum: String(r.checksum),
      appliedAt: date(r.applied_at),
      rolledBackAt:
        r.rolled_back_at == null ? undefined : date(r.rolled_back_at),
      failed: Number(r.failed) === 1 || r.failed === true,
      error: r.error == null ? undefined : String(r.error),
      logs: r.logs == null ? undefined : String(r.logs),
    }));
  }
  async recordApplied(file: MigrationFile, connection: SqlQueryable = this.executor): Promise<void> {
    await this.write(file.id, file.checksum, false, null, null, connection);
  }
  async markFailed(id: string, error: string, logs?: string): Promise<void> {
    await this.write(id, "", true, error, logs ?? null);
  }

  private async write(
    id: string,
    checksum: string,
    failed: boolean,
    error: string | null,
    logs: string | null,
    connection: SqlQueryable = this.executor,
  ): Promise<void> {
    // Migrator holds the database lock for the entire read/update pair.
    const p = (i: number): string => this.sql.param(i);
    const c = (name: string): string => this.column(name);
    const exists = await connection.query(
      `select ${c("id")} from ${this.table} where ${c("id")}=${p(1)}`,
      [id],
    );
    const params = [id, checksum || "0", failed ? 1 : 0, error, logs];
    if (exists.rows.length) {
      await connection.query(
        `update ${this.table} set ${c("checksum")}=${p(2)}, ${c("failed")}=${p(3)}, ${c("error")}=${p(4)}, ${c("logs")}=${p(5)}, ${c("applied_at")}=${this.now}, ${c("rolled_back_at")}=null where ${c("id")}=${p(1)}`,
        params,
      );
    } else {
      const columns = ["id", "checksum", "failed", "error", "logs"];
      await connection.query(
        `insert into ${this.table} (${columns.map(c).join(", ")}) values (${columns.map((_, i) => p(i + 1)).join(", ")})`,
        params,
      );
    }
  }
  async markRolledBack(id: string): Promise<boolean> {
    const c = (name: string): string => this.column(name);
    const where = `where ${c("id")}=${this.sql.param(1)}`;
    const { rows } = await this.executor.query(
      `select ${c("id")} from ${this.table} ${where}`,
      [id],
    );
    if (!rows.length) return false;
    await this.executor.query(
      `update ${this.table} set ${c("rolled_back_at")}=${this.now}, ${c("failed")}=0 ${where}`,
      [id],
    );
    return true;
  }
}
function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
