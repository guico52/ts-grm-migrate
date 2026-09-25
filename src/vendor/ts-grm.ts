/**
 * ts-grm 依赖的唯一入口（适配层）。
 * TableDef、ColumnDef 与约束类型声明改写自 ts-grm 的 schema_def.ts：
 * 仅保留迁移器所需字段，调整类型名称和引用，并添加本项目的适配接口及实现。
 * 原作者 陈涛 (Chen Tao)；改写部分保留 Apache-2.0 许可与署名。
 * @see ../../THIRD_PARTY_NOTICES.md
 * @see https://github.com/babyfish-ct/ts-grm/blob/fe78eb6c323bf335ff23650a414856eb36bfbce7/packages/sql/src/impl/schema_def.ts
 *
 * 约定：migrate 源码中所有对 `@ts-grm/*` 的 import 必须经过本文件，
 * 禁止在业务代码里直接 `import ... from "@ts-grm/sql"` 等。
 *
 * 依赖形态（2026-09-11 起）：`@ts-grm/core` / `@ts-grm/sql` 是**运行时依赖**
 * （npm `^0.0.13`），不再是 yarn workspace 跨目录挂载 —— migrate 是 ts-grm 的
 * 插件，宿主由 npm 提供。上游换代时本文件是唯一修改点。
 *
 * 上游 API 现状（0.0.13 实测）与适配点：
 * - 公开导出里**没有** `createSchema` / `TableDef` / `ColumnDef` / `ConstraintDef`
 *   / `SqlClientImplementor` —— 上游把 schema 定义收回了内部模块。
 * - 结构化表定义唯一的公开入口是 `sqlClient.createSchema()`，但它的**公开类型**
 *   （`@ts-grm/core` 的 `Schema`）只暴露 creationSqlArray / deletionSqlArray /
 *   execute / toString，即只有 SQL 字符串，没有结构；diff 引擎需要结构。
 * - 该调用的运行时返回值是上游内部的 SchemaImpl，其上有 `tableDefs: TableDef[]`。
 *   **本文件的 `createSchema()` 是全仓库唯一读取该内部字段的地方**；
 *   上游一旦公开结构化 API，只改这一个函数即可。
 * - `TableDef` / `ColumnDef` / `ConstraintDef` 上游未导出，此处按 dist 类型声明
 *   镜像（结构等价；子类型一律引用 core 的公开类型，不引入 any）。
 */
import { MySqlDriver as UpstreamMySqlDriver } from "@ts-grm/sql";
import type { CascadeType, ScalarType, SqlClient, spi } from "@ts-grm/core";

// ---- 上游公开 API 的再导出（值）--------------------------------------------

export {
  newSqlClient,
  PostgresDriver,
  SqliteDriver,
  OracleDriver,
  // 上游拼写就是 Drivier（不是笔误），此处沿用
  Oracle12Drivier,
  SqlServerDriver,
  SqlServer2012Driver,
  // 驱动配套的连接池（Oracle / SQL Server 不走 pg 的连接池）
  OraclePool,
  SqlServerPool,
} from "@ts-grm/sql";
export { ScalarType, EntityManager, model, prop } from "@ts-grm/core";
export type { SqlClientOptions } from "@ts-grm/sql";
export type { CascadeType, SqlClient } from "@ts-grm/core";

// ---- 目标态结构类型（上游未导出，按 dist 声明镜像）--------------------------

/**
 * 方言映射能力 —— migrate 对上游 `Driver` 的最小结构化投影。
 *
 * 只声明 migrate 实际用到的部分（适配器取列类型名、DDL 生成器透传给
 * `toCreationStatements`），因此不依赖上游未导出的 `Driver` 类型。
 */
export interface SchemaDriver {
  typeName(columnDef: ColumnDef): string;
}

/** 上游 TableDef 的结构镜像（见文件头注释） */
export interface TableDef {
  readonly entity: spi.Entity | undefined;
  readonly prop: spi.EntityProp | undefined;
  readonly name: string;
  readonly columns: ReadonlyArray<ColumnDef>;
  readonly constraints: ReadonlyArray<ConstraintDef>;
  toCreationStatements(driver: SchemaDriver): ReadonlyArray<string>;
  toDeletionStatements(driver: SchemaDriver): ReadonlyArray<string>;
}

/** 上游 ColumnDef 的结构镜像 */
export interface ColumnDef {
  readonly declaringTable: TableDef;
  readonly prop: spi.EntityProp | undefined;
  readonly name: string;
  readonly type: ScalarType<any>;
  readonly nullable: boolean;
  readonly length: number | undefined;
  readonly precision: number | undefined;
  readonly scale: number | undefined;
  readonly when: ReadonlyArray<spi.Entity> | undefined;
}

/** 上游 ConstraintDef 的结构镜像（判别联合，保序：PRIMARY_KEY/INDEX → UNIQUE → CHECK → FOREIGN_KEY） */
export type ConstraintDef =
  | SimpleConstraintDef
  | ForeignKeyConstraintDef;

export type SimpleConstraintDef =
  | {
      readonly kind: "PRIMARY_KEY" | "INDEX";
      readonly columns: ReadonlyArray<ColumnDef>;
      readonly implicit: "MIDDLE_TABLE" | undefined;
    }
  | {
      readonly kind: "UNIQUE";
      readonly columns: ReadonlyArray<ColumnDef>;
      readonly implicit: "ASSOCIATION" | "MIDDLE_ENTITY" | undefined;
    }
  | {
      readonly kind: "CHECK";
      readonly column: ColumnDef;
      readonly values: ReadonlyArray<string | number>;
      readonly implicit: "POLYMORPHISM" | undefined;
    };

export type ForeignKeyConstraintDef = {
  readonly kind: "FOREIGN_KEY";
  readonly columns: ReadonlyArray<ColumnDef>;
  readonly referencedColumns: ReadonlyArray<ColumnDef>;
  readonly cascade: CascadeType;
  readonly implicit: "INHERITANCE" | undefined;
};

/**
 * 上游 sqlClient 实现的结构镜像（上游的 `SqlClientImplementor` 未导出）。
 * `newSqlClient()` 的公开返回类型是 `SqlClient`，运行时实例额外带 `driver`。
 */
export interface SqlClientImplementor extends SqlClient {
  readonly driver: SchemaDriver;
}

// ---- 目标 schema 获取（上游内部字段的唯一适配点）--------------------------

/**
 * 从 ts-grm 模型推导目标态表定义（`createSchema()` 的适配封装）。
 *
 * 上游只公开 SQL 字符串（`Schema.creationSqlArray`），而 diff 需要结构化定义，
 * 因此这里读取运行时实例上的 `tableDefs`。**这是全仓库唯一的内部字段依赖点**，
 * 上游若公开结构化 API，替换本函数实现即可。
 *
 * 读不到时抛可读错误（外部输入路径不 fail-fast 的原则，见 schema/model.ts）。
 */
export async function createSchema(
  client: SqlClient,
): Promise<ReadonlyArray<TableDef>> {
  const schema = await client.createSchema();
  const tableDefs = (
    schema as unknown as { readonly tableDefs?: ReadonlyArray<TableDef> }
  ).tableDefs;
  if (tableDefs == null) {
    throw new Error(
      "ts-grm createSchema() did not return structured table definitions (tableDefs is missing). " +
        "The upstream schema implementation may have changed; check src/vendor/ts-grm.ts.",
    );
  }
  return tableDefs;
}

/** Upstream 0.0.13 spells FLOAT as flat. Keep the correction at the upstream boundary.
 * @see https://github.com/babyfish-ct/ts-grm/blob/main/packages/sql/src/driver/mysql_driver.ts
 */
export class MySqlDriver extends UpstreamMySqlDriver {
  override typeName(column: Parameters<UpstreamMySqlDriver["typeName"]>[0]): string {
    return column.type.kind === "F32" ? "float" : super.typeName(column);
  }
}
