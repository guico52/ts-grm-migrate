import { it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteIntrospector } from '../src/introspector/sqlite';
import { SqliteSqlExecutor } from '../src/executor/sqlite';
import { PostgresSqlExecutor } from '../src/executor/postgres';
import { SqliteDdlGenerator } from '../src/ddl/sqlite';
import { SchemaDiffer } from '../src/differ';
import { checkKey } from '../src/schema/checks';
import type { Schema, Table, ForeignKeyConstraint } from '../src/schema/model';

const table = (name = 't'): Table => ({
  name,
  columns: [
    {
      name: 'v',
      type: 'integer',
      nullable: true,
      length: undefined,
      default: undefined,
      autoIncrement: false,
      ordinal: 1,
      comment: undefined,
    },
  ],
  constraints: [],
  indexes: [],
});

it('SQLite CHECKs round-trip including quotes, comments and nested expressions', async () => {
  const db = new Database(':memory:');
  try {
    const target: Schema = {
      tables: [
        {
          ...table(),
          constraints: [
            {
              kind: 'CHECK',
              name: undefined,
              implicit: undefined,
              values: [1, 2],
              expression: '"v" in (1, 2)',
            },
          ],
        },
      ],
    };
    const ddl = new SqliteDdlGenerator();
    db.exec(ddl.createStatements(target).join(';'));
    const introspector = new SqliteIntrospector({ query: new SqliteSqlExecutor(db) });
    expect(
      new SchemaDiffer('sqlite').diff(await introspector.introspect(), target).changes,
    ).toEqual([]);
    db.exec(
      `create table q(x text check(x <> 'CHECK (a,b)'), y integer check((y + 1) > 0) /* CHECK (fake) */)`,
    );
    const q = (await introspector.introspect()).tables.find((t) => t.name === 'q')!;
    expect(q.constraints.filter((c) => c.kind === 'CHECK')).toHaveLength(2);
  } finally {
    db.close();
  }
});

it('PostgreSQL literal membership normalizes deparsed forms without erasing semantic differences', () => {
  const types = new Map([
    ['kind', 'character varying(30)'],
    ['v', 'integer'],
  ]);
  const key = (sql: string) => checkKey(sql, 'postgres', types);
  expect(key(`"kind" in ('Book', 'O''Brien, X')`)).toBe(
    key(`((kind)::text = ANY (ARRAY['Book'::text, 'O''Brien, X'::text]))`),
  );
  expect(key(`"kind" in ('Book', 'O''Brien, X')`)).toBe(
    key(
      `((kind)::text = ANY ((ARRAY['Book'::character varying, 'O''Brien, X'::character varying])::text[]))`,
    ),
  );
  expect(key('"v" in (1, 2)')).toBe(key('(v = ANY (ARRAY[1, 2]))'));
  expect(key('"v" in (1)')).toBe(key('(v = 1)'));
  expect(key(`kind in ('book')`)).not.toBe(key(`kind in ('Book')`));
  expect(key("(v::text = ANY (ARRAY['1']))")).not.toBe(key('v in (1)'));
  expect(key('v = true')).not.toBe(key('"v" = "true"'));
});

it('foreign-key deferrability participates in differ', () => {
  const fk: ForeignKeyConstraint = {
    kind: 'FOREIGN_KEY',
    name: 'fk',
    columns: ['v'],
    referencedTable: 'p',
    referencedColumns: ['v'],
    onDelete: 'NO_ACTION',
    deferrable: false,
    cascade: 'NONE',
    implicit: undefined,
  };
  expect(
    new SchemaDiffer().diff(
      { tables: [{ ...table(), constraints: [fk] }] },
      { tables: [{ ...table(), constraints: [{ ...fk, deferrable: true }] }] },
    ).changes,
  ).toHaveLength(1);
});

it('SQLite drops referencing tables first and refuses cyclic drop plans', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'create table a_parent(v integer primary key); create table b_child(v integer references a_parent(v)); insert into a_parent values(1); insert into b_child values(1)',
    );
    const from = await new SqliteIntrospector({ query: new SqliteSqlExecutor(db) }).introspect(),
      to: Schema = { tables: [] };
    const ddl = new SqliteDdlGenerator();
    const sql = ddl.statements(new SchemaDiffer('sqlite').diff(from, to), { from, to });
    expect(sql[0]).toContain('b_child');
    await new SqliteSqlExecutor(db).executeStatements(sql);
    expect(
      (await new SqliteIntrospector({ query: new SqliteSqlExecutor(db) }).introspect()).tables,
    ).toEqual([]);
    db.exec(
      'create table a(v integer primary key, b integer references b(v)); create table b(v integer primary key, a integer references a(v))',
    );
    const cyclic = await new SqliteIntrospector({ query: new SqliteSqlExecutor(db) }).introspect();
    expect(() =>
      ddl.statements(new SchemaDiffer('sqlite').diff(cyclic, to), { from: cyclic, to }),
    ).toThrow(/cyclic/);
  } finally {
    db.close();
  }
});

it('SQLite preserves partial index predicates and refuses managed special indexes', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      'create table t(v integer); create unique index ux on t(v) where v > 0; create index expr on t(abs(v))',
    );
    const actual = await new SqliteIntrospector({ query: new SqliteSqlExecutor(db) }).introspect();
    expect(actual.tables[0]!.indexes.find((i) => i.name === 'ux')!.predicate).toBe('v > 0');
    expect(actual.tables[0]!.indexes.find((i) => i.name === 'expr')!.unsupported).toBeDefined();
    const partial = actual.tables[0]!.indexes.find((i) => i.name === 'ux')!;
    const supported = { tables: [{ ...actual.tables[0]!, indexes: [partial] }] };
    expect(
      new SchemaDiffer('sqlite').diff(supported, {
        tables: [{ ...supported.tables[0]!, indexes: [{ ...partial, predicate: 'v>0' }] }],
      }).changes,
    ).toEqual([]);
    expect(
      new SchemaDiffer('sqlite').diff(actual, { tables: [{ ...table(), indexesManaged: false }] })
        .changes,
    ).toEqual([]);
    expect(() => new SchemaDiffer('sqlite').diff(actual, { tables: [table()] })).toThrow(
      /special index/,
    );
    db.exec('create table generated(x integer, y integer generated always as(x+1))');
    await expect(
      new SqliteIntrospector({ query: new SqliteSqlExecutor(db) }).introspect(),
    ).rejects.toThrow(/generated or hidden/);
  } finally {
    db.close();
  }
});

it('PostgreSQL pins queries, DDL and completion to the lock session and destroys failed unlock sessions', async () => {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('pg_advisory_unlock') ? [{ unlocked: true }] : [],
  }));
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
    query: vi.fn(async () => ({ rows: [] })),
  };
  const executor = new PostgresSqlExecutor(pool);
  const acquiring = executor.acquireMigrationLock('k');
  await expect(executor.acquireMigrationLock('k')).rejects.toThrow(/lock is held/);
  const unlock = await acquiring;
  await executor.query('select 1');
  await executor.executeStatements(['select 2'], async (connection) => {
    await connection.query('select 3');
  });
  expect(pool.connect).toHaveBeenCalledTimes(1);
  expect(pool.query).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(new Error('unlock failed'));
  await expect(unlock()).rejects.toThrow('unlock failed');
  expect(release).toHaveBeenCalledWith(expect.any(Error));
});

it('SQLite file locks span independent connections and symlink paths', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tgm-sqlite-lock-'));
  const file = path.join(dir, 'db'),
    alias = path.join(dir, 'alias');
  const a = new Database(file),
    b = new Database(file);
  try {
    await symlink(file, alias);
    const first = new SqliteSqlExecutor(a),
      second = new SqliteSqlExecutor(b, alias);
    const release = await first.acquireMigrationLock('first-checkout');
    await expect(second.acquireMigrationLock('second-checkout')).rejects.toThrow(/lock is held/);
    await release();
    const next = await second.acquireMigrationLock('second-checkout');
    await next();
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('SQLite resolves omitted parent key columns and rejects unsupported deferred constraints', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('create table p(v integer primary key); create table child(v integer references p)');
    const introspector = new SqliteIntrospector({ query: new SqliteSqlExecutor(db) });
    const child = (await introspector.introspect()).tables.find((t) => t.name === 'child')!;
    expect(child.constraints[0]).toMatchObject({ referencedColumns: ['v'] });
    db.exec('create table deferred(v integer references p(v) deferrable initially deferred)');
    await expect(introspector.introspect()).rejects.toThrow(/special table semantics/);
  } finally {
    db.close();
  }
});
