import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, validateExcludeTables } from '../src/config';
import { createCatalogTableFilter } from '../src/introspector';
import { createTableMatcher } from '../src/table-filter';

describe('表名匹配', () => {
  it.each([
    ['sys_*', 'sys_user', 'other_sys_user'],
    ['*_log', 'access_log', 'access_logs'],
    ['order_*_detail', 'order_item_detail', 'order_detail'],
    ['report_????', 'report_2026', 'report_202601'],
    ['report_[0-9][0-9]', 'report_01', 'report_ab'],
    ['{order,payment}_*', 'payment_202611', 'audit_202611'],
    ['sys_\\*', 'sys_*', 'sys_user'],
    ['order_2026.11_*', 'order_2026.11_01', 'order_2026X11_01'],
    ['.sys_*', '.sys_users', 'sys_users'],
    ['sys_**', 'sys_user', 'orders'],
    ['a(b)', 'a(b)', 'ab'],
    ['a(b)*', 'a(b)_01', 'ab_01'],
    ['report_[0-9][0-9]', 'report_01', 'report_[0-9][0-9]'],
    ['report_[0-9][0-9]', 'report_01', 'report_01\n'],
    ['a|b*', 'a|b_01', 'a_01'],
    ['a\\(b\\)*', 'a(b)_01', 'ab_01'],
    ['a+b', 'a+b', 'aab'],
    ['orders', 'orders', 'orders_01'],
  ])('glob %s 匹配 %s，不匹配 %s', (pattern, yes, no) => {
    const matches = createTableMatcher([pattern]);
    expect(matches(yes)).toBe(true);
    expect(matches(no)).toBe(false);
  });

  it('支持混合规则、Unicode、空数组及默认大小写敏感', () => {
    const matches = createTableMatcher(['sys_*', /^order_\d{6}_\d{2}$/, '审计_*']);
    expect(matches('order_202611_03')).toBe(true);
    expect(matches('sys_user')).toBe(true);
    expect(matches('审计_2026')).toBe(true);
    expect(matches('SYS_user')).toBe(false);
    expect(matches('order_202611')).toBe(false);
    expect(createTableMatcher([])('orders')).toBe(false);
    expect(createTableMatcher(undefined)('orders')).toBe(false);
  });

  it('RegExp 支持 flags 和原生的子串匹配，复制后不受 lastIndex 或 compile 修改影响', () => {
    const pattern = /order_\d+/i;
    pattern.lastIndex = 100;
    const matches = createTableMatcher([pattern]);
    pattern.compile('different');
    for (let i = 0; i < 5; i++) expect(matches('prefix_ORDER_01_suffix')).toBe(true);
    expect(createTableMatcher([/^order_\d+$/])('prefix_order_01')).toBe(false);
  });

  it.each([/orders/g, /orders/y, /orders/gy])('拒绝有状态正则 %s', (pattern) => {
    expect(() => validateExcludeTables([pattern])).toThrow(/g or y flags/);
  });

  it.each(['order_[', 'order_{a,b', '!sys_*'])('拒绝无效或否定 glob %s', (pattern) => {
    expect(() => createTableMatcher([pattern])).toThrow(/excludeTables/);
  });

  it('未命中表不调用依赖回调，命中的分表保留引用信息', () => {
    const references: string[] = [];
    const included = createCatalogTableFilter({
      excludeTables: [/^archive_\d{6}$/],
      onExcludedReference: (table, ref) => references.push(`${table}->${ref}`),
    });
    expect(included('archive_202611', 'orders')).toBe(false);
    expect(included('archive_current', 'orders')).toBe(true);
    expect(references).toEqual(['archive_202611->orders']);
  });

  it('真实 ESM 配置保留 RegExp 对象并校验 flags', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tgm-pattern-config-'));
    try {
      await writeFile(
        path.join(dir, 'valid.mjs'),
        "export default {database:{},models:['./models'],excludeTables:['sys_*',/^order_\\d{6}$/i]}",
      );
      const { config } = await loadConfig(dir, 'valid.mjs');
      expect(config.excludeTables![1]).toBeInstanceOf(RegExp);
      expect(createTableMatcher(config.excludeTables)('ORDER_202611')).toBe(true);
      await writeFile(
        path.join(dir, 'invalid.mjs'),
        "export default {database:{},models:['./models'],excludeTables:[/order/g]}",
      );
      await expect(loadConfig(dir, 'invalid.mjs')).rejects.toThrow(/g or y flags/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
