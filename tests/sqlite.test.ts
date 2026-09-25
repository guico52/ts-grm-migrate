/**
 * SQLite 方言的单元测试：类型归一化、introspection、DDL 的行为边界。
 * 用真实的内存库（better-sqlite3），不需要任何外部服务。
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { SqliteIntrospector, normalizeSqliteType } from "../src/introspector/sqlite";
import { SqliteSqlExecutor } from "../src/executor/sqlite";
import { SqliteDdlGenerator } from "../src";
import type { Schema } from "../src/schema/model";

function memoryDb(): Database.Database {
  return new Database(":memory:");
}

describe("normalizeSqliteType：与 ts-grm SqliteDriver.typeName 对齐", () => {
  it("ts-grm 只产出 text / integer / real / blob", () => {
    expect(normalizeSqliteType("integer")).toBe("integer");
    expect(normalizeSqliteType("text")).toBe("text");
    expect(normalizeSqliteType("real")).toBe("real");
    expect(normalizeSqliteType("blob")).toBe("blob");
  });

  it("外部库的声明类型按 SQLite 亲和性归并", () => {
    expect(normalizeSqliteType("INT")).toBe("integer");
    expect(normalizeSqliteType("BIGINT")).toBe("integer");
    expect(normalizeSqliteType("VARCHAR(50)")).toBe("text");
    expect(normalizeSqliteType("CLOB")).toBe("text");
    expect(normalizeSqliteType("DOUBLE PRECISION")).toBe("real");
    expect(normalizeSqliteType("NUMERIC(10,2)")).toBe("real");
    expect(normalizeSqliteType("BLOB")).toBe("blob");
    // 大小写与前后的空白都要吃掉
    expect(normalizeSqliteType("  Integer ")).toBe("integer");
    // 未声明类型 → BLOB 亲和性
    expect(normalizeSqliteType("")).toBe("blob");
  });
});

describe("SqliteIntrospector", () => {
  it("读出表、列、主键、外键与索引", async () => {
    const db = memoryDb();
    try {
      db.exec(`create table A (id integer not null, name text not null, constraint A_pk primary key (id))`);
      db.exec(
        `create table B (
           id integer not null,
           a_id integer,
           constraint B_pk primary key (id),
           constraint B_fk foreign key (a_id) references A (id) on delete cascade
         )`,
      );
      db.exec(`create index B_a_idx on B (a_id)`);

      const schema = await new SqliteIntrospector({
        query: new SqliteSqlExecutor(db),
      }).introspect();

      expect(schema.tables.map((t) => t.name)).toEqual(["A", "B"]);

      const [a, b] = schema.tables;
      expect(a!.columns.map((c) => `${c.name}:${c.type}:${c.nullable}`)).toEqual([
        "id:integer:false",
        "name:text:false",
      ]);
      // 主键从 table_info 的 pk 列还原（不能靠 index_list：integer 主键是 rowid 别名）
      expect(a!.constraints).toEqual([
        { kind: "PRIMARY_KEY", name: undefined, columns: ["id"], implicit: undefined },
      ]);

      // 外键：SQLite 不保存约束名，cascade 由 ON DELETE 反推
      expect(b!.constraints).toEqual([
        { kind: "PRIMARY_KEY", name: undefined, columns: ["id"], implicit: undefined },
        {
          kind: "FOREIGN_KEY",
          name: undefined,
          columns: ["a_id"],
          referencedTable: "A",
          referencedColumns: ["id"],
          onDelete: "CASCADE",
          deferrable: false,
          cascade: "DELETE",
          implicit: undefined,
        },
      ]);

      expect(b!.indexes).toEqual([
        { name: "B_a_idx", columns: ["a_id"], unique: false, predicate: undefined },
      ]);
    } finally {
      db.close();
    }
  });

  it("复合主键与复合外键保持列序", async () => {
    const db = memoryDb();
    try {
      db.exec(`create table P (a integer not null, b integer not null, constraint P_pk primary key (a, b))`);
      db.exec(
        `create table Q (
           x integer,
           y integer,
           constraint Q_fk foreign key (x, y) references P (a, b)
         )`,
      );

      const schema = await new SqliteIntrospector({
        query: new SqliteSqlExecutor(db),
      }).introspect();

      const p = schema.tables.find((t) => t.name === "P")!;
      expect(p.constraints).toEqual([
        { kind: "PRIMARY_KEY", name: undefined, columns: ["a", "b"], implicit: undefined },
      ]);

      const q = schema.tables.find((t) => t.name === "Q")!;
      const fk = q.constraints.find((c) => c.kind === "FOREIGN_KEY")!;
      expect(fk).toMatchObject({ columns: ["x", "y"], referencedColumns: ["a", "b"] });
    } finally {
      db.close();
    }
  });

  it("unique 约束与普通索引分开（前者来自 unique 约束，后者来自 create index）", async () => {
    const db = memoryDb();
    try {
      db.exec(`create table U (id integer primary key, code text unique)`);
      db.exec(`create index U_id_idx on U (id)`);

      const schema = await new SqliteIntrospector({
        query: new SqliteSqlExecutor(db),
      }).introspect();

      const u = schema.tables[0]!;
      expect(u.constraints).toEqual([
        { kind: "PRIMARY_KEY", name: undefined, columns: ["id"], implicit: undefined },
        { kind: "UNIQUE", name: undefined, columns: ["code"], implicit: undefined },
      ]);
      // 主键的自动索引（origin=pk）不能混进来
      expect(u.indexes).toEqual([
        { name: "U_id_idx", columns: ["id"], unique: false, predicate: undefined },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("SqliteSqlExecutor", () => {
  it("executeStatements 失败时整体回滚", async () => {
    const db = memoryDb();
    try {
      const executor = new SqliteSqlExecutor(db);
      await executor.executeStatements([`create table T (id integer)`]);

      await expect(
        executor.executeStatements([
          `insert into T (id) values (1)`,
          `this is not sql`,
        ]),
      ).rejects.toThrow(/Statement failed \(transaction rolled back\)/);

      const { rows } = await executor.query(`select count(*) as n from T`);
      expect(Number(rows[0]!["n"])).toBe(0);
    } finally {
      db.close();
    }
  });

  it("不返回行的语句也能通过 query 执行（insert / update）", async () => {
    const db = memoryDb();
    try {
      const executor = new SqliteSqlExecutor(db);
      await executor.executeStatements([`create table T (id integer)`]);
      const { rows } = await executor.query(`insert into T (id) values (1)`);
      expect(rows).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("迁移锁是 no-op（SQLite 是嵌入式单文件库）", async () => {
    const db = memoryDb();
    try {
      const release = await new SqliteSqlExecutor(db).acquireMigrationLock("any-key");
      await expect(release()).resolves.toBeUndefined();
      // 幂等：重复解锁不再报错
      await expect(release()).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("SqliteDdlGenerator 的行为边界", () => {
  const diffWith = (changes: Schema extends never ? never : Parameters<SqliteDdlGenerator["statements"]>[0]["changes"]) =>
    ({ changes, destructive: [] });

  it("drop table 直接执行（SQLite 删表不校验外键依赖）", () => {
    const sql = new SqliteDdlGenerator().statements(
      diffWith([{ kind: "DROP_TABLE", table: "OLD", foreignKeyNames: ["old_fk"] }]),
    );
    expect(sql).toEqual([`drop table "OLD"`]);
  });

  it("ADD_COLUMN 原地执行", () => {
    const sql = new SqliteDdlGenerator().statements(
      diffWith([
        {
          kind: "ALTER_TABLE",
          table: "T",
          columns: [
            {
              kind: "ADD_COLUMN",
              column: {
                name: "C",
                type: "integer",
                nullable: true,
                length: undefined,
                default: undefined,
                autoIncrement: false,
                ordinal: 1,
                comment: undefined,
              },
            },
          ],
          constraints: [],
          indexes: [],
        },
      ]),
    );
    expect(sql).toEqual([`alter table "T" add column "C" integer null`]);
  });

  it("需要重建表时显式报错，而不是生成丢数据的语句", () => {
    const generator = new SqliteDdlGenerator();
    expect(() =>
      generator.statements(
        diffWith([
          {
            kind: "ALTER_TABLE",
            table: "T",
            columns: [{ kind: "DROP_COLUMN", column: "C" }],
            constraints: [],
            indexes: [],
          },
        ]),
      ),
    ).toThrow(/table rebuild is not implemented/);
  });
});
