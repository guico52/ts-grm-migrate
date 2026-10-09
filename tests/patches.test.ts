/**
 * 列级补丁（`ts-grm-patches` 的 autoIncrement / default）支持测试。
 *
 * 两层：
 * 1. 适配层单元：用假的 TableDef / prop 覆盖「管理 / 不管理 / 冲突 / 渲染」；
 * 2. 真实链路端到端：`applyPatches()` + 真实 model(...) → createSchema →
 *    适配器 → SQLite 建表 SQL → 执行 → introspect → **diff 为空**。
 *    这是能力真正落地的最强证据：只要 default / AUTOINCREMENT 的写法与
 *    introspection 对不上，往返 diff 就会非空。
 */
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { applyPatches } from 'ts-grm-patches';
import {
  EntityManager,
  model,
  prop,
  dsl,
  newSqlClient,
  ScalarType,
  SqliteDriver,
  createSchema,
} from '../src/vendor/ts-grm';
import type { ColumnDef, SchemaDriver, SqlClientImplementor, TableDef } from '../src/vendor/ts-grm';
import { tableDefsToSchema } from '../src/schema/adapter';
import { readColumnPatch, renderColumnDefault } from '../src/schema/patches';
import { SchemaDiffer } from '../src/differ';
import { SqliteDdlGenerator } from '../src/ddl/sqlite';
import { SqliteIntrospector } from '../src/introspector/sqlite';
import { SqliteSqlExecutor } from '../src/executor/sqlite';
import type { Schema } from '../src/schema/model';

// 必须在任何 model(...) 定义之前安装（补丁的硬性要求）
applyPatches();

// ---- 假 TableDef（适配层单元）------------------------------------------------

interface FakeColumn {
  readonly name: string;
  readonly prop?: unknown;
}

function fakeTableDef(name: string, columns: ReadonlyArray<FakeColumn>): TableDef {
  const tableDef = { name, columns: [], constraints: [] } as unknown as {
    name: string;
    columns: Array<ColumnDef>;
    constraints: Array<TableDef['constraints'][number]>;
  };
  tableDef.columns = columns.map(
    (c) =>
      ({
        declaringTable: tableDef,
        prop: c.prop,
        name: c.name,
        type: c.name === 'status' || c.name === 'title' ? ScalarType.str(20) : ScalarType.I32,
        nullable: false,
        length: undefined,
        precision: undefined,
        scale: undefined,
        when: undefined,
      }) as unknown as ColumnDef,
  );
  return tableDef as unknown as TableDef;
}

const fakeDriver = {
  typeName: (column: ColumnDef): string => (column.type.kind === 'STR' ? 'text' : 'integer'),
} as unknown as SchemaDriver;

function adapt(tableDef: TableDef, dialect: 'postgres' | 'sqlite' | 'mysql' = 'postgres'): Schema {
  return tableDefsToSchema([tableDef], fakeDriver, { dialect });
}

describe('列级补丁适配', () => {
  it('未安装补丁（prop 无这些成员）→ default / autoIncrement 不管理', () => {
    const schema = adapt(fakeTableDef('T', [{ name: 'id' }, { name: 'status' }]));
    for (const column of schema.tables[0]!.columns) {
      expect(column.default).toBeUndefined();
      expect(column.autoIncrement).toBe(false);
      expect(column.autoIncrementManaged).toBeUndefined();
    }
  });

  it('补丁声明了 default → 目标态渲染为方言字面量；未声明的列是「无默认值」', () => {
    const schema = adapt(
      fakeTableDef('T', [
        { name: 'id' },
        { name: 'status', prop: { autoIncrement: false, default: 'active' } },
        { name: 'title', prop: { autoIncrement: false, default: undefined } },
      ]),
    );
    const [id, status, title] = schema.tables[0]!.columns;
    expect(status!.default).toBe("'active'");
    // "" 是 differ 的「删除默认值」约定（模型未声明 = 目标态无默认值）
    expect(title!.default).toBe('');
    // id 没暴露 default 读取器 → 不管理默认值
    expect(id!.default).toBeUndefined();
  });

  it('补丁声明了 autoIncrement → 自增值 + 管理标记', () => {
    const schema = adapt(
      fakeTableDef('T', [
        { name: 'id', prop: { autoIncrement: true, default: undefined } },
        { name: 'status', prop: { autoIncrement: false, default: undefined } },
      ]),
    );
    const [id, status] = schema.tables[0]!.columns;
    expect(id!.autoIncrement).toBe(true);
    expect(id!.autoIncrementManaged).toBe(true);
    expect(status!.autoIncrement).toBe(false);
    // 未声明 default 但补丁在：自增列不表达默认值
    expect(id!.default).toBeUndefined();
  });

  it('同时声明 autoIncrement 与 default → 明确报错', () => {
    expect(() =>
      adapt(fakeTableDef('T', [{ name: 'id', prop: { autoIncrement: true, default: 0 } }])),
    ).toThrow(/both autoIncrement\(\) and default/);
  });
});

describe('readColumnPatch 探测', () => {
  it('普通对象（无补丁读取器）→ 不管理', () => {
    expect(readColumnPatch({})).toEqual({
      autoIncrementManaged: false,
      autoIncrement: false,
      defaultManaged: false,
      default: undefined,
    });
    expect(readColumnPatch(undefined).defaultManaged).toBe(false);
  });

  it('原型链上的读取器也能探测到（补丁就装在原型上）', () => {
    class Prop {}
    Object.defineProperty(Prop.prototype, 'autoIncrement', { get: () => true });
    Object.defineProperty(Prop.prototype, 'default', { get: () => 'x' });
    expect(readColumnPatch(new Prop())).toMatchObject({
      autoIncrementManaged: true,
      autoIncrement: true,
      defaultManaged: true,
      default: 'x',
    });
  });
});

describe('renderColumnDefault', () => {
  const context = { table: 'T', column: 'C', dialect: 'postgres' as const };

  it('字面量按方言转义', () => {
    expect(renderColumnDefault("it's", context)).toBe("'it''s'");
    expect(renderColumnDefault(0, context)).toBe('0');
    expect(renderColumnDefault(true, context)).toBe('true');
    expect(renderColumnDefault(10n, context)).toBe('10');
    expect(renderColumnDefault('1', { ...context, dialect: 'mysql' })).toBe("'1'");
    expect(renderColumnDefault(1, { ...context, dialect: 'mysql' })).toBe("'1'");
    expect(renderColumnDefault(false, { ...context, dialect: 'sqlite' })).toBe('false');
  });

  it('dsl.native 表达式按模板片段渲染', () => {
    expect(renderColumnDefault(dsl.native.date`now()`, context)).toBe('now()');
    expect(renderColumnDefault(dsl.native.str`uuid_generate_v4()`, context)).toBe(
      'uuid_generate_v4()',
    );
    // SQLite / MySQL 的默认值表达式必须带括号
    expect(renderColumnDefault(dsl.native.date`now()`, { ...context, dialect: 'sqlite' })).toBe(
      '(now())',
    );
  });

  it('非 native 表达式 / 非法插值 → 报错', () => {
    expect(() =>
      renderColumnDefault({ __type: () => ({ expressionLike: true }) }, context),
    ).toThrow(/Unsupported default value/);
    expect(() =>
      renderColumnDefault({ parts: [[dsl.native.num`1`, dsl.native.num`2`]] }, context),
    ).toThrow(/Unsupported dsl.native interpolation/);
  });
});

// ---- 真实链路端到端（SQLite 内存库）----------------------------------------

const USER = model(
  'PatchUser',
  'id',
  class {
    id = prop.i32().autoIncrement();
    status = prop.str(20).default('active');
    createdAt = prop.dt().default(dsl.native.date`CURRENT_TIMESTAMP`);
    nickname = prop.str(20);
  },
);

const POST = model(
  'PatchPost',
  'id',
  class {
    id = prop.i32();
    title = prop.str(100).default('untitled');
  },
);

describe('端到端：模型 → SQLite 建表 → introspect 往返 diff 为空', () => {
  const database = new Database(':memory:');
  afterAll(() => database.close());

  const sqlClient = newSqlClient(new SqliteDriver(database), {
    entityManager: EntityManager.combine(USER as never, POST as never),
  }) as unknown as SqlClientImplementor;
  const executor = new SqliteSqlExecutor(database);
  const introspector = new SqliteIntrospector({ query: executor });
  const generator = new SqliteDdlGenerator();

  it('适配器把补丁元数据带进目标态', async () => {
    const tableDefs = await createSchema(sqlClient as never);
    const target = tableDefsToSchema(tableDefs, sqlClient.driver, { dialect: 'sqlite' });
    const user = target.tables.find((t) => t.name === 'PATCH_USER');
    expect(user).toBeDefined();
    const byName = new Map(user!.columns.map((c) => [c.name, c]));
    expect(byName.get('ID')).toMatchObject({ autoIncrement: true, autoIncrementManaged: true });
    expect(byName.get('STATUS')!.default).toBe("'active'");
    expect(byName.get('CREATED_AT')!.default).toBe('(CURRENT_TIMESTAMP)');
    expect(byName.get('NICKNAME')!.default).toBe('');
  });

  it('建表 SQL 携带 AUTOINCREMENT 与默认值，且执行后往返无差异', async () => {
    const tableDefs = await createSchema(sqlClient as never);
    const target = tableDefsToSchema(tableDefs, sqlClient.driver, { dialect: 'sqlite' });
    const from: Schema = { tables: [] };
    const diff = new SchemaDiffer().diff(from, target);
    const statements = generator.statements(diff);

    const userSql = statements.find((s) => s.includes('PATCH_USER'));
    expect(userSql).toContain('"ID" integer not null primary key autoincrement');
    expect(userSql).toContain("default 'active'");
    expect(userSql).toContain('default (CURRENT_TIMESTAMP)');

    await executor.executeStatements(statements);
    // 插入一行：自增主键与默认值真的生效（不只是元数据好看）
    await executor.executeStatements([`insert into "PATCH_USER" ("NICKNAME") values ('n')`]);
    const rows = await executor.query(`select "ID", "STATUS", "CREATED_AT" from "PATCH_USER"`);
    expect(rows.rows[0]).toMatchObject({ ID: 1, STATUS: 'active' });
    expect(String(rows.rows[0]!.CREATED_AT)).not.toBe('');

    const actual = await introspector.introspect();
    const roundTrip = new SchemaDiffer().diff(actual, target);
    expect(roundTrip.changes).toEqual([]);
    // introspect 读回的自增列与模型声明一致
    const actualUser = actual.tables.find((t) => t.name === 'PATCH_USER');
    expect(actualUser!.columns.find((c) => c.name === 'ID')!.autoIncrement).toBe(true);
  });
});
