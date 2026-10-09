import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnostics, type DiagnosticKey } from '../src/diagnostics/catalog.js';
import { diagnostic, DiagnosticAggregateError, formatError } from '../src/diagnostics/error.js';
import { describeDiff } from '../src/drift.js';

describe('diagnostic localization', () => {
  it('every diagnostic has Chinese prose and preserves its technical parameters', () => {
    for (const [key, template] of Object.entries(diagnostics)) {
      expect(template['zh-CN'], key).toMatch(/[\u4e00-\u9fff]/);
      const indices = [...template['zh-CN'].matchAll(/\{(\d+)\}/g)].map((match) =>
        Number(match[1]),
      );
      const args = Array.from(
        { length: Math.max(-1, ...indices) + 1 },
        (_, i) => `identifier_${i}`,
      );
      const message = formatError(diagnostic(key as DiagnosticKey, ...args), 'zh-CN');
      for (const index of indices) expect(message, key).toContain(args[index]);
      expect(message, key).not.toMatch(/\{\d+\}/);
      expect(formatError(diagnostic(key as DiagnosticKey, ...args), 'en')).toBe(
        template.en.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)])),
      );
    }
  });

  it('localizes nested failure wrappers and driver errors without leaking English descriptions', () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    const error = diagnostic(
      'migrator_8',
      '20261009_init',
      diagnostic('executor_postgres_1', driver),
    );
    const output = formatError(error, 'zh-CN');
    expect(output).toContain('迁移 "20261009_init" 执行失败');
    expect(output).toContain('事务已回滚');
    expect(output).toContain('违反唯一性约束');
    expect(output).toContain('23505');
    expect(output).not.toMatch(/Migration|Statement failed|duplicate key|transaction rolled back/);
    expect(formatError(error, 'zh-CN', true)).toContain(driver.message);
    expect(formatError(error, 'zh-CN', true)).not.toMatch(/Migration|Statement failed/);
    expect(formatError(error, 'en')).toContain('transaction rolled back');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('detail does not reintroduce English tool descriptions when there is no external error', () => {
    const error = diagnostic('config_4', '/project/config.mjs');
    expect(formatError(error, 'zh-CN', true)).toBe('配置文件 "/project/config.mjs" 缺少数据库连接设置。');
  });

  it('retains both failures when migration failure recording also fails', () => {
    const first = diagnostic(
      'executor_sqlite_1',
      Object.assign(new Error('near bad'), { code: 'SQLITE_ERROR' }),
    );
    const second = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
      path: '/data/app.db',
    });
    const error = new DiagnosticAggregateError([first, second], 'migrator_record_failure', [
      '001_init',
      first,
      second,
    ]);
    expect(error).toBeInstanceOf(AggregateError);
    const output = formatError(error, 'zh-CN');
    expect(output).toContain('记录失败状态也失败');
    expect(output).toContain('没有访问权限');
    expect(output).toContain('/data/app.db');
    expect(output).not.toMatch(/recording the failure|permission denied|near bad/);
  });

  it.each([
    { code: 'EREQUEST', number: 2627 },
    { code: 'ORA-00001', errorNum: 1 },
  ])('localizes numeric server errors while keeping the codes and constraint name: %o', (fields) => {
    const error = Object.assign(new Error('duplicate key'), fields, { constraint: 'USER_NAME_unique' });
    const output = formatError(error, 'zh-CN');
    expect(output).toContain('违反唯一性约束');
    expect(output).toContain(fields.code);
    expect(output).toContain('约束 USER_NAME_unique');
    expect(output).not.toContain('duplicate key');
  });

  it('handles circular upstream error causes in detail output', () => {
    const upstream = new Error('unknown upstream message');
    upstream.cause = upstream;
    expect(formatError(diagnostic('model_load', upstream), 'zh-CN', true)).toContain('原始诊断');
  });

  it('translates constraint descriptions while preserving identifiers and SQL', () => {
    const output = describeDiff(
      {
        changes: [
          {
            kind: 'ALTER_TABLE',
            table: 'USER',
            columns: [],
            indexes: [],
            constraints: [
              {
                kind: 'ADD_CONSTRAINT',
                constraint: {
                  name: undefined,
                  implicit: undefined,
                  kind: 'PRIMARY_KEY',
                  columns: ['ID'],
                },
              },
              {
                kind: 'ADD_CONSTRAINT',
                constraint: {
                  name: undefined,
                  implicit: undefined,
                  kind: 'UNIQUE',
                  columns: ['NAME'],
                },
              },
              {
                kind: 'ADD_CONSTRAINT',
                constraint: {
                  name: undefined,
                  implicit: undefined,
                  values: [],
                  kind: 'CHECK',
                  expression: 'ID > 0',
                },
              },
              {
                kind: 'ADD_CONSTRAINT',
                constraint: {
                  name: undefined,
                  implicit: undefined,
                  cascade: 'NONE',
                  kind: 'FOREIGN_KEY',
                  columns: ['ROLE_ID'],
                  referencedTable: 'ROLE',
                  referencedColumns: ['ID'],
                  onDelete: 'NO_ACTION',
                  deferrable: false,
                },
              },
            ],
          },
        ],
        destructive: [],
      },
      'zh-CN',
    )
      .map((item) => item.summary)
      .join('\n');
    expect(output).toContain('主键 (ID)');
    expect(output).toContain('唯一约束 (NAME)');
    expect(output).toContain('检查约束 (ID > 0)');
    expect(output).toContain('外键 (ROLE_ID) → ROLE');
    expect(output).not.toMatch(/primary key|foreign key|unique|check/);
  });

  it('project-authored error descriptions must use the bilingual catalog', async () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    async function inspect(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await inspect(file);
        else if (entry.name.endsWith('.ts') && file !== path.join(root, 'diagnostics/error.ts')) {
          const source = await readFile(file, 'utf8');
          expect(source, file).not.toMatch(
            /throw new (?:Error|TypeError|RangeError|AggregateError)\s*\(/,
          );
        }
      }
    }
    await inspect(root);
  });
});
