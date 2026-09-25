import { createHash } from "node:crypto";
import type { MigrationCompletion, SqlExecutor } from "../executor.js";

export interface OracleSession {
  execute(
    sql: string,
    binds: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<{
    rows?: ReadonlyArray<Record<string, unknown>>;
    outBinds?: unknown;
  }>;
}
/** @see https://docs.oracle.com/en/database/oracle/oracle-database/23/arpls/DBMS_LOCK.html */
export class OracleSqlExecutor implements SqlExecutor {
  private locked = false;
  constructor(
    private readonly session: OracleSession,
    private readonly schema: string,
    private readonly lockTimeout = 10,
  ) {}
  async query(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }> {
    // OUT_FORMAT_OBJECT=4002. Runtime enables CLOB-to-string fetching on this connection's queries.
    const result = await this.session.execute(
      sql,
      Object.fromEntries(
        params.map((value, index) => [String(index + 1), value]),
      ),
      { autoCommit: true, outFormat: 4002 },
    );
    return { rows: result.rows ?? [] };
  }
  async executeStatements(statements: ReadonlyArray<string>, complete?: MigrationCompletion): Promise<void> {
    // Parse the whole input first: unsupported PL/SQL must not leave a half-executed file.
    const parsed = statements.flatMap(splitOracleSql);
    try {
      for (const sql of parsed) await this.query(sql);
      await complete?.(this);
    } catch (e) {
      throw new Error(
        `Oracle statement failed: ${(e as Error).message}. DDL commits implicitly; earlier statements may have applied. Inspect the database before using resolve.`,
      );
    }
  }
  async acquireMigrationLock(_key: string): Promise<() => Promise<void>> {
    if (this.locked) throw new Error("This Oracle executor already holds a migration lock");
    // A deterministic numeric ID avoids ALLOCATE_UNIQUE's implicit commit and extra catalog writes.
    const id =
      createHash("sha256")
        .update(`ts-grm:${this.schema}`)
        .digest()
        .readUInt32BE(0) % 1073741824;
    await this
      .query(`declare result integer; begin result := dbms_lock.request(${id}, 6, ${this.lockTimeout}, false);
      if result <> 0 then raise_application_error(-20001, 'Migration lock failed: ' || result); end if; end;`);
    this.locked = true;
    return async () => {
      if (!this.locked) return;
      await this
        .query(`declare result integer; begin result := dbms_lock.release(${id});
        if result <> 0 then raise_application_error(-20002, 'Migration unlock failed: ' || result); end if; end;`);
      this.locked = false;
    };
  }
}

/**
 * SQL-only migration files: semicolons in strings, quoted identifiers and comments are data.
 * PL/SQL and SQL*Plus commands are explicitly rejected before execution; no naive split(';').
 * @see https://node-oracledb.readthedocs.io/en/latest/user_guide/sql_execution.html
 */
export function splitOracleSql(source: string): string[] {
  const statements: string[] = [];
  let current = "",
    quote = "",
    comment = "",
    alternativeEnd = "";
  const finish = (): void => {
    const sql = current.trim();
    current = "";
    if (!sql) return;
    if (
      /^(begin|declare|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type)|\/|set\s+|prompt\s+|exec(?:ute)?\s+)/i.test(
        sql,
      )
    ) {
      throw new Error(
        "Oracle 迁移文件当前只支持 SQL，不支持 PL/SQL 或 SQL*Plus 命令",
      );
    }
    statements.push(sql);
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!,
      next = source[i + 1];
    if (comment === "line") {
      if (c === "\n") {
        comment = "";
        current += "\n";
      }
      continue;
    }
    if (comment === "block") {
      if (c === "*" && next === "/") {
        comment = "";
        i++;
        current += " ";
      }
      continue;
    }
    if (alternativeEnd) {
      current += c;
      if (c === alternativeEnd && next === "'") {
        current += "'";
        i++;
        alternativeEnd = "";
      }
      continue;
    }
    if (quote) {
      current += c;
      if (c === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = "";
      }
      continue;
    }
    if ((c === "q" || c === "Q") && next === "'" && source[i + 2]) {
      const delimiter = source[i + 2]!;
      alternativeEnd =
        ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[
          delimiter
        ] ?? delimiter;
      current += source.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (c === "-" && next === "-") {
      comment = "line";
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      comment = "block";
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === ";") finish();
    else current += c;
  }
  if (quote || alternativeEnd || comment === "block")
    throw new Error("Oracle SQL file contains an unterminated string or comment");
  finish();
  return statements;
}
