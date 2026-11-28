import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, validateAllowDropTables } from '../src/config';
import { PostgresDdlGenerator } from '../src/ddl/postgres';
import { SqliteDdlGenerator } from '../src/ddl/sqlite';
import type { Diff } from '../src/diff/types';
import { SqliteSqlExecutor } from '../src/executor/sqlite';
import { SqliteIntrospector } from '../src/introspector/sqlite';
import { Migrator } from '../src/migrator';
import type { Schema } from '../src/schema/model';
import { checksumOf, DatabaseMigrationHistoryStore, FileMigrationStore } from '../src/store';

describe('allowDropTables（真实 SQLite）', () => {
  let dir: string;
  let db: Database.Database;
  let executor: SqliteSqlExecutor;
  let introspector: SqliteIntrospector;
  let files: FileMigrationStore;
  let history: DatabaseMigrationHistoryStore;
  let target: Schema;
  let confirmed: Diff[];
  const create = (allowDropTables?: boolean) =>
    new Migrator({
      files,
      history,
      executor,
      introspector,
      ddl: new SqliteDdlGenerator(),
      targetSchema: async () => target,
      migrationsDir: path.join(dir, 'migrations'),
      lockPath: path.join(dir, 'lock'),
      allowDropTables,
      confirm: async (diff) => {
        confirmed.push(diff);
        return true;
      },
    });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tgm-drop-tables-'));
    db = new Database(':memory:');
    db.exec(`create table item(id integer primary key, name text);
      create table archive(id integer primary key);
      insert into archive values(7)`);
    executor = new SqliteSqlExecutor(db);
    introspector = new SqliteIntrospector({ query: executor });
    files = new FileMigrationStore(path.join(dir, 'migrations'));
    history = new DatabaseMigrationHistoryStore({ executor, dialect: 'sqlite' });
    const actual = await introspector.introspect();
    target = { tables: actual.tables.filter((table) => table.name === 'item') };
    confirmed = [];
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('显式 true 时开启自动删表', async () => {
    const result = await create(true).push();
    expect(result.statements).toContain('drop table "archive"');
    expect(result.drift).toEqual([]);
    expect(confirmed[0]!.destructive).toContainEqual({
      kind: 'DROP_TABLE',
      table: 'archive',
      foreignKeyNames: [],
    });
    expect(db.prepare("select name from sqlite_master where name='archive'").all()).toEqual([]);
  });

  it.each([undefined, false])(
    '默认或 false 时不生成删表或空迁移，保留严格差异报告：%s',
    async (setting) => {
      const migrator = create(setting);
      const preview = await migrator.push({ dryRun: true });
      expect(preview.statements).toEqual([]);
      expect(preview.diff).toEqual({ changes: [], destructive: [] });
      expect(preview.drift.map((drift) => drift.table)).toEqual(['archive']);
      const dev = await migrator.dev({ createOnly: true });
      expect(dev.migrationId).toBeUndefined();
      expect(dev.drift.map((drift) => drift.table)).toEqual(['archive']);
      expect((await migrator.push()).drift.map((drift) => drift.table)).toEqual(['archive']);
      expect((await migrator.checkDrift()).map((drift) => drift.table)).toEqual(['archive']);
      expect(await files.listFiles()).toEqual([]);
      expect(confirmed).toEqual([]);
      expect(db.prepare('select * from archive').all()).toEqual([{ id: 7 }]);
    },
  );

  it('false 时仍生成并部署建表及加列，不删除保留表', async () => {
    const item = target.tables[0]!;
    const column = { ...item.columns[1]!, name: 'note', ordinal: 3 };
    target = {
      tables: [
        { ...item, columns: [...item.columns, column] },
        { ...item, name: 'new_item' },
      ],
    };
    const migrator = create(false);
    const created = await migrator.dev({ createOnly: true });
    expect(created.diff.changes.map((change) => change.kind)).toEqual([
      'ALTER_TABLE',
      'CREATE_TABLE',
    ]);
    const sql = (await files.listFiles())[0]!.sql;
    expect(sql).toContain('add column');
    expect(sql).toContain('create table');
    expect(sql).not.toContain('drop table');
    const result = await migrator.deploy();
    expect(result.drift.map((drift) => drift.table)).toEqual(['archive']);
    expect(db.prepare('select note from item').all()).toEqual([]);
    expect(db.prepare('select * from new_item').all()).toEqual([]);
    expect(db.prepare('select * from archive').all()).toEqual([{ id: 7 }]);
  });

  it('false 不放宽 baseline 的结构校验', async () => {
    await expect(create(false).baseline()).rejects.toThrow(/differs from models/);
    expect(await files.listFiles()).toEqual([]);
  });

  it('false 不改写已有迁移 SQL', async () => {
    const sql = 'drop table "archive";';
    await files.write({
      id: '20261128000100000_drop',
      sortKey: '20261128000100000_drop',
      sql,
      checksum: checksumOf(sql),
    });
    expect((await create(false).deploy()).drift).toEqual([]);
    expect(db.prepare("select name from sqlite_master where name='archive'").all()).toEqual([]);
  });

  it('false 只限制删表，删列仍进入 DDL 和破坏性确认列表', async () => {
    const actual = await introspector.introspect();
    const item = target.tables[0]!;
    const migrator = new Migrator({
      files,
      history,
      executor,
      introspector: { dialect: 'postgres', introspect: async () => actual },
      ddl: new PostgresDdlGenerator(),
      targetSchema: async () => ({ tables: [{ ...item, columns: item.columns.slice(0, 1) }] }),
      migrationsDir: dir,
      lockPath: path.join(dir, 'lock'),
      allowDropTables: false,
    });
    const result = await migrator.push({ dryRun: true });
    expect(result.statements).toContain('alter table "item" drop column "name"');
    expect(result.statements.some((sql) => /drop table/i.test(sql))).toBe(false);
    expect(result.diff.destructive).toContainEqual({
      kind: 'DROP_COLUMN',
      table: 'item',
      column: 'name',
    });
  });

  it('保留表引用变更列时，DDL 拆除外键后会重新建立', async () => {
    const actual = await introspector.introspect();
    const item = target.tables[0]!;
    const foreignKey = {
      kind: 'FOREIGN_KEY' as const,
      name: 'archive_item_fk',
      columns: ['id'],
      referencedTable: 'item',
      referencedColumns: ['id'],
      onDelete: 'NO_ACTION' as const,
      deferrable: false,
      cascade: 'NONE' as const,
      implicit: undefined,
    };
    const from: Schema = {
      tables: actual.tables.map((table) =>
        table.name === 'archive'
          ? { ...table, constraints: [...table.constraints, foreignKey] }
          : table,
      ),
    };
    const migrator = new Migrator({
      files,
      history,
      executor,
      introspector: { dialect: 'postgres', introspect: async () => from },
      ddl: new PostgresDdlGenerator(),
      targetSchema: async () => ({
        tables: [
          {
            ...item,
            columns: item.columns.map((column) =>
              column.name === 'id' ? { ...column, type: 'bigint' } : column,
            ),
          },
        ],
      }),
      migrationsDir: dir,
      lockPath: path.join(dir, 'lock'),
      allowDropTables: false,
    });
    const result = await migrator.push({ dryRun: true });
    expect(result.statements).toContain('alter table "archive" drop constraint "archive_item_fk"');
    expect(
      result.statements.some((sql) =>
        sql.startsWith('alter table "archive" add constraint "archive_item_fk"'),
      ),
    ).toBe(true);
    expect(result.statements.some((sql) => /drop table/i.test(sql))).toBe(false);
  });

  it('真实 ESM 配置支持布尔开关并拒绝字符串', async () => {
    await writeFile(
      path.join(dir, 'valid.mjs'),
      "export default { database: {}, models:['./m'], allowDropTables:false }",
    );
    expect((await loadConfig(dir, 'valid.mjs')).config.allowDropTables).toBe(false);
    await writeFile(
      path.join(dir, 'invalid.mjs'),
      "export default { database: {}, models:['./m'], allowDropTables:'false' }",
    );
    await expect(loadConfig(dir, 'invalid.mjs')).rejects.toThrow(/allowDropTables/);
  });
});

it.each([null, 'false', 0, [], {}])('拒绝无效 allowDropTables: %j', (value) => {
  expect(() => validateAllowDropTables(value)).toThrow(/allowDropTables/);
});
