import { describe, expect, it } from 'vitest';
import type { Introspector, SqlQueryable } from '../src/introspector';
import { MysqlIntrospector } from '../src/introspector/mysql';
import { OracleIntrospector } from '../src/introspector/oracle';
import { PostgresIntrospector } from '../src/introspector/postgres';
import { SqlServerIntrospector } from '../src/introspector/sqlserver';

type Row = Record<string, unknown>;
const catalog = (entries: Array<[string, Row[]]>): SqlQueryable => ({
  async query(sql) {
    return { rows: entries.find(([pattern]) => sql.includes(pattern))?.[1] ?? [] };
  },
});

const cases: Array<[string, () => Introspector]> = [
  [
    'postgres',
    () =>
      new PostgresIntrospector({
        query: catalog([
          ['from pg_attribute', [{ table_name: 'legacy', name: 'computed', generated: 's' }]],
          ['from pg_index', []],
          [
            'from pg_constraint',
            [{ table_name: 'legacy', kind: 'f', referenced_table: 'item', validated: false }],
          ],
          ['from pg_class', [{ name: 'legacy', kind: 'p' }]],
        ]),
      }),
  ],
  [
    'mysql',
    () =>
      new MysqlIntrospector({
        query: catalog([
          ['information_schema.TABLES', [{ name: 'legacy', engine: 'MyISAM' }]],
          ['information_schema.COLUMNS', [{ TABLE_NAME: 'legacy', GENERATION_EXPRESSION: 'bad' }]],
          [
            'information_schema.TABLE_CONSTRAINTS',
            [{ TABLE_NAME: 'legacy', REFERENCED_TABLE_NAME: 'item' }],
          ],
        ]),
      }),
  ],
  [
    'mssql',
    () =>
      new SqlServerIntrospector({
        query: catalog([
          ['select t.name, t.temporal_type', [{ name: 'legacy', temporal_type: 2 }]],
          ['from sys.foreign_keys', [{ table_name: 'legacy', ref_table: 'item' }]],
        ]),
      }),
  ],
  [
    'oracle',
    () =>
      new OracleIntrospector({
        schema: 'APP',
        query: catalog([
          ['from all_tables', [{ TABLE_NAME: 'legacy', TEMPORARY: 'Y' }]],
          ['from all_constraints', [{ TABLE_NAME: 'legacy', REF_TABLE: 'item' }]],
        ]),
      }),
  ],
];

describe.each(cases)('%s 管理范围', (_dialect, create) => {
  it.each(['legacy', 'leg*', /^legacy$/])(
    '模式 %s 在解析之前过滤特殊表，同时保留外键依赖',
    async (pattern) => {
      const references: string[] = [];
      const schema = await create().introspect({
        excludeTables: [pattern],
        onExcludedReference: (table, ref) => references.push(`${table}->${ref}`),
      });
      expect(schema.tables).toEqual([]);
      expect(references).toContain('legacy->item');
    },
  );
  it('未排除的特殊表继续拒绝，不能全局禁用结构保护', async () => {
    await expect(create().introspect()).rejects.toThrow();
  });
});
