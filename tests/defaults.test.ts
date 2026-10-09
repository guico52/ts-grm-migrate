import { describe, expect, it } from 'vitest';
import { sameDefault } from '../src/schema/defaults';

describe('column default equivalence', () => {
  it.each(['postgres', 'mysql', 'sqlite', 'mssql', 'oracle'] as const)(
    'preserves textual digits in %s',
    (dialect) => {
      expect(sameDefault("'01'", "'1'", 'varchar(20)', dialect)).toBe(false);
      expect(sameDefault("'1.0'", "'1'", 'text', dialect)).toBe(false);
    },
  );
  it('compares exact decimals and integers without floating point', () => {
    expect(sameDefault('9007199254740992', '9007199254740993', 'bigint', 'postgres')).toBe(false);
    expect(sameDefault("'9007199254740992'", "'9007199254740993'", 'bigint', 'mysql')).toBe(false);
    expect(sameDefault('0.10000000000000000001', '0.1', 'numeric', 'postgres')).toBe(false);
    expect(sameDefault('-001.2000', '-1.2', 'numeric', 'postgres')).toBe(true);
    expect(sameDefault('1e3', '1000.00', 'numeric', 'postgres')).toBe(true);
    expect(sameDefault("'01'", '1', 'integer', 'mysql')).toBe(true);
  });
  it('only removes whole-literal casts compatible with the column', () => {
    expect(sameDefault("'active'::character varying", "'active'", 'varchar(20)', 'postgres')).toBe(
      true,
    );
    expect(sameDefault("'001'::integer", "'001'", 'text', 'postgres')).toBe(false);
    expect(sameDefault("'abcdef'::varchar(2)", "'abcdef'", 'varchar(20)', 'postgres')).toBe(false);
    expect(sameDefault("'001'::text || 'x'", "'001'::integer || 'x'", 'text', 'postgres')).toBe(
      false,
    );
    expect(sameDefault('now()::date', 'now()', 'date', 'postgres')).toBe(false);
  });
  it('normalizes Unicode catalog prefixes only on SQL Server', () => {
    expect(sameDefault("((N'active'))", "'active'", 'nvarchar(20)', 'mssql')).toBe(true);
    expect(sameDefault("N'active'", "'active'", 'text', 'postgres')).toBe(false);
  });
});
