import { createHash } from 'node:crypto';
import { asError, diagnostic } from '../diagnostics/error.js';
import type { MigrationCompletion, SqlExecutor } from '../executor.js';

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
    // OUT_FORMAT_OBJECT=4002。runtime 为该连接的查询开启 CLOB 转字符串。
    const result = await this.session.execute(
      sql,
      Object.fromEntries(params.map((value, index) => [String(index + 1), value])),
      { autoCommit: true, outFormat: 4002 },
    );
    return { rows: result.rows ?? [] };
  }
  async executeStatements(
    statements: ReadonlyArray<string>,
    complete?: MigrationCompletion,
  ): Promise<void> {
    // 先解析完整输入：遇到不支持的 PL/SQL 时，不能留下执行了一半的文件。
    const parsed = statements.flatMap(splitOracleSql);
    try {
      for (const sql of parsed) await this.query(sql);
      await complete?.(this);
    } catch (e) {
      throw diagnostic('executor_oracle_1', asError(e));
    }
  }
  async acquireMigrationLock(_key: string): Promise<() => Promise<void>> {
    if (this.locked) throw diagnostic('executor_oracle_2');
    // 使用确定的数字 ID，避免 ALLOCATE_UNIQUE 的隐式提交和额外的 catalog 写入。
    const id =
      createHash('sha256').update(`ts-grm:${this.schema}`).digest().readUInt32BE(0) % 1073741824;
    await this.query(`declare result integer; begin result := dbms_lock.request(${id}, 6, ${this.lockTimeout}, false);
      if result <> 0 then raise_application_error(-20001, 'Migration lock failed: ' || result); end if; end;`);
    this.locked = true;
    return async () => {
      if (!this.locked) return;
      await this.query(`declare result integer; begin result := dbms_lock.release(${id});
        if result <> 0 then raise_application_error(-20002, 'Migration unlock failed: ' || result); end if; end;`);
      this.locked = false;
    };
  }
}

/**
 * 迁移文件只能包含 SQL：字符串、带引号标识符和注释中的分号都视为数据。
 * PL/SQL 和 SQL*Plus 命令在执行前明确拒绝；不使用简单的 split(';')。
 * @see https://node-oracledb.readthedocs.io/en/latest/user_guide/sql_execution.html
 */
export function splitOracleSql(source: string): string[] {
  const statements: string[] = [];
  let current = '',
    quote = '',
    comment = '',
    alternativeEnd = '';
  const finish = (): void => {
    const sql = current.trim();
    current = '';
    if (!sql) return;
    if (
      /^(begin|declare|create\s+(or\s+replace\s+)?(procedure|function|package|trigger|type)|\/|set\s+|prompt\s+|exec(?:ute)?\s+)/i.test(
        sql,
      )
    ) {
      throw diagnostic('executor_oracle_3');
    }
    statements.push(sql);
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!,
      next = source[i + 1];
    if (comment === 'line') {
      if (c === '\n') {
        comment = '';
        current += '\n';
      }
      continue;
    }
    if (comment === 'block') {
      if (c === '*' && next === '/') {
        comment = '';
        i++;
        current += ' ';
      }
      continue;
    }
    if (alternativeEnd) {
      current += c;
      if (c === alternativeEnd && next === "'") {
        current += "'";
        i++;
        alternativeEnd = '';
      }
      continue;
    }
    if (quote) {
      current += c;
      if (c === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = '';
      }
      continue;
    }
    if ((c === 'q' || c === 'Q') && next === "'" && source[i + 2]) {
      const delimiter = source[i + 2]!;
      alternativeEnd =
        ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[delimiter] ??
        delimiter;
      current += source.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (c === '-' && next === '-') {
      comment = 'line';
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      comment = 'block';
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === ';') finish();
    else current += c;
  }
  if (quote || alternativeEnd || comment === 'block') throw diagnostic('executor_oracle_4');
  finish();
  return statements;
}
