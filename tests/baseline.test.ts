import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateExcludeTables } from '../src/config';
import { SqliteDdlGenerator } from '../src/ddl/sqlite';
import { SchemaDiffer } from '../src/differ';
import { SqliteSqlExecutor } from '../src/executor/sqlite';
import { SqliteIntrospector } from '../src/introspector/sqlite';
import { Migrator } from '../src/migrator';
import type { Schema } from '../src/schema/model';
import { DatabaseMigrationHistoryStore, FileMigrationStore } from '../src/store';

describe.each([['legacy'], ['leg*'], [/^legacy$/]])(
  '部分表接管与 baseline（真实 SQLite，%s）',
  (pattern) => {
    let db: Database.Database;
    let dir: string;
    let target: Schema;
    let migrator: Migrator;
    let files: FileMigrationStore;
    let introspector: SqliteIntrospector;
    let history: DatabaseMigrationHistoryStore;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'tgm-baseline-'));
      db = new Database(':memory:');
      db.exec(`create table item(id integer primary key, name text not null default 'old');
      insert into item values(1,'kept');
      create table legacy(id integer primary key, special text) strict;
      insert into legacy values(1,'untouched');`);
      const executor = new SqliteSqlExecutor(db);
      introspector = new SqliteIntrospector({ query: executor });
      target = await introspector.introspect({ excludeTables: [pattern] });
      files = new FileMigrationStore(path.join(dir, 'migrations'));
      history = new DatabaseMigrationHistoryStore({ executor, dialect: 'sqlite' });
      migrator = new Migrator({
        files,
        history,
        executor,
        introspector,
        ddl: new SqliteDdlGenerator(),
        targetSchema: async () => target,
        migrationsDir: dir,
        lockPath: path.join(dir, 'lock'),
        excludeTables: [pattern],
      });
    });
    afterEach(async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('保留业务数据、忽略不支持的表，基线可在空库重放，后续增量可部署', async () => {
      expect(await migrator.checkDrift()).toEqual([]);
      const { migrationId } = await migrator.baseline();
      const [file] = await files.listFiles();
      expect(file!.id).toBe(migrationId);
      expect(file!.sql).not.toContain('legacy');
      expect((await migrator.status()).pending).toEqual([]);
      expect(db.prepare('select name from item').get()).toEqual({ name: 'kept' });
      expect(db.prepare('select special from legacy').get()).toEqual({ special: 'untouched' });
      const fresh = new Database(':memory:');
      try {
        fresh.exec(file!.sql);
        const actual = await new SqliteIntrospector({
          query: new SqliteSqlExecutor(fresh),
        }).introspect();
        expect(new SchemaDiffer('sqlite').diff(actual, target).changes).toEqual([]);
      } finally {
        fresh.close();
      }
      const table = target.tables[0]!;
      target = {
        tables: [
          {
            ...table,
            columns: [
              ...table.columns,
              {
                ...table.columns[1]!,
                name: 'note',
                nullable: true,
                default: undefined,
                ordinal: 3,
              },
            ],
          },
        ],
      };
      const created = await migrator.dev({ createOnly: true, name: 'note' });
      expect(created.diff.changes).toHaveLength(1);
      await migrator.deploy();
      expect(await migrator.checkDrift()).toEqual([]);
      expect(db.prepare('select name, note from item').get()).toEqual({ name: 'kept', note: null });
      expect(db.prepare('select special from legacy').get()).toEqual({ special: 'untouched' });
      await expect(migrator.baseline()).rejects.toThrow(/empty migration directory/);
    });

    it('自动忽略按月新建的物理分表，不复制或删除这些表', async () => {
      const executor = new SqliteSqlExecutor(db);
      const sharded = new Migrator({
        files,
        history,
        executor,
        introspector,
        ddl: new SqliteDdlGenerator(),
        targetSchema: async () => target,
        migrationsDir: dir,
        lockPath: path.join(dir, 'lock'),
        excludeTables: [/^legacy(?:_\d{6})?$/],
      });
      db.exec(
        'create table legacy_202611(id integer primary key) strict; insert into legacy_202611 values(11)',
      );
      await sharded.baseline();
      expect((await files.listFiles())[0]!.sql).not.toContain('legacy');
      db.exec(
        'create table legacy_202612(id integer primary key) strict; insert into legacy_202612 values(12)',
      );
      expect(await sharded.checkDrift()).toEqual([]);
      expect((await sharded.push({ dryRun: true })).statements).toEqual([]);
      expect((await sharded.dev({})).applied).toBe(false);
      await sharded.deploy();
      expect(db.prepare('select * from legacy_202611').all()).toEqual([{ id: 11 }]);
      expect(db.prepare('select * from legacy_202612').all()).toEqual([{ id: 12 }]);
    });

    it('模型差异时不生成文件、不写历史、不改业务数据', async () => {
      target = { tables: [] };
      await expect(migrator.baseline()).rejects.toThrow(/differs from models/);
      expect(await files.listFiles()).toEqual([]);
      expect(await history.listApplied()).toEqual([]);
      expect(db.prepare('select name from item').get()).toEqual({ name: 'kept' });
    });

    it('拒绝已存在的迁移文件与历史', async () => {
      await migrator.baseline();
      // 文件缺失也不能重新接管有历史的数据库。
      await rm(path.join(dir, 'migrations'), { recursive: true });
      await expect(migrator.baseline()).rejects.toThrow(/no migration history/);
    });

    it('保留被排除表的模型，所有迁移路径忽略其结构差异', async () => {
      target = { tables: [...target.tables, { ...target.tables[0]!, name: 'legacy' }] };
      expect(await migrator.checkDrift()).toEqual([]);
      expect((await migrator.push({ dryRun: true })).statements).toEqual([]);
      expect((await migrator.push()).statements).toEqual([]);
      expect((await migrator.dev({ createOnly: true })).migrationId).toBeUndefined();
      await migrator.baseline();
      expect((await files.listFiles())[0]!.sql).not.toContain('legacy');
      expect((await migrator.deploy()).drift).toEqual([]);
      expect(db.prepare('select special from legacy').get()).toEqual({ special: 'untouched' });
      expect(target.tables.map((table) => table.name)).toEqual(['item', 'legacy']);
    });

    it('被排除表在数据库中缺失时，不根据模型创建它', async () => {
      db.exec('drop table legacy');
      target = { tables: [...target.tables, { ...target.tables[0]!, name: 'legacy' }] };
      expect(await migrator.checkDrift()).toEqual([]);
      expect((await migrator.push()).statements).toEqual([]);
      await migrator.baseline();
      expect((await files.listFiles())[0]!.sql).not.toContain('legacy');
      await migrator.deploy();
      expect(db.prepare("select name from sqlite_master where name='legacy'").all()).toEqual([]);
    });

    it('受管理表的变更仍生成迁移，DDL 上下文不包含被排除模型', async () => {
      const table = target.tables[0]!;
      target = {
        tables: [
          {
            ...table,
            columns: [
              ...table.columns,
              {
                ...table.columns[1]!,
                name: 'note',
                nullable: true,
                default: undefined,
                ordinal: 3,
              },
            ],
          },
          { ...table, name: 'legacy' },
        ],
      };
      const generated = await migrator.dev({ createOnly: true });
      expect(generated.diff.changes.map((change) => change.table)).toEqual(['item']);
      expect((await files.listFiles())[0]!.sql).not.toContain('legacy');
      await migrator.deploy();
      expect(await migrator.checkDrift()).toEqual([]);
      expect(db.prepare('select note from item').get()).toEqual({ note: null });
      expect(db.prepare('select special from legacy').get()).toEqual({ special: 'untouched' });
    });

    it('迁移历史表仍不允许作为业务模型，即使命中排除规则', async () => {
      target = { tables: [{ ...target.tables[0]!, name: history.tableName }] };
      await expect(migrator.checkDrift()).rejects.toThrow(/reserved for migration history/);
    });

    it('push 与 dry-run 不管理被排除表，模型移除仍生成删表', async () => {
      target = { tables: [] };
      const preview = await migrator.push({ dryRun: true });
      expect(preview.statements).toEqual(['drop table "item"']);
      await migrator.push();
      expect(db.prepare('select special from legacy').get()).toEqual({ special: 'untouched' });
      await expect(migrator.baseline()).rejects.toThrow(/empty managed schema/);
    });

    it('忽略表引用受管理表时允许基线，阻止对被引用表的结构变更', async () => {
      db.exec('alter table legacy add column item_id integer references item(id)');
      await migrator.baseline();
      target = { tables: [] };
      await expect(migrator.dev({ createOnly: true })).rejects.toThrow(/legacy -> item/);
      await expect(migrator.push()).rejects.toThrow(/legacy -> item/);
      expect(await files.listFiles()).toHaveLength(1);
    });

    it('受管理表引用忽略表时明确拒绝', async () => {
      db.exec('alter table item add column legacy_id integer references legacy(id)');
      target = await introspector.introspect({ excludeTables: [pattern] });
      await expect(migrator.baseline()).rejects.toThrow(/item -> legacy/);
    });

    it('基线文件保留模型未管理的默认值和索引', async () => {
      db.exec('create index item_name on item(name)');
      target = {
        tables: target.tables.map((t) => ({
          ...t,
          indexesManaged: false,
          columns: t.columns.map((c) => ({ ...c, default: undefined })),
        })),
      };
      await migrator.baseline();
      const [file] = await files.listFiles();
      expect(file!.sql).toContain("default 'old'");
      expect(file!.sql).toContain('item_name');
    });
  },
);

it.each([null, 'legacy', [''], [123], ['a\0b']])('拒绝无效 excludeTables: %j', (value) => {
  expect(() => validateExcludeTables(value)).toThrow(/excludeTables/);
});
