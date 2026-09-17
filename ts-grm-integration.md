# ts-grm 对接分析：migrate 需要的工作

> 状态：探索分析（2026-08-13），基于 ts-grm 本地仓库当前源码。
> 目的：明确 `@ts-grm/migrate` 各分层需要从 ts-grm 对接什么、阻塞点、以及建议的实施顺序。
> 所有事实均标注 ts-grm 源码路径与行号，可复核。

## 1. 背景

- migrate 的定位：为 ts-grm 提供 Prisma Migrate 式能力（增量迁移 + push），分层对应 prisma-engines。
- 依赖方式：yarn 4 workspace 跨目录挂载 `../../source/ts-grm/packages/*`，`@ts-grm/sql` 以 `workspace:*` 引用；发布后改 npm 版本号，改名风险由 `src/vendor/ts-grm.ts` 适配层隔离。
- 本文档回答：**migrate 每一层需要 ts-grm 的哪些能力、当前缺什么、谁来做**。

## 2. 现状盘点

### 2.1 ts-grm 侧

两个包：

- `@ts-grm/core`（`packages/core`）：类型系统、表达式 DSL、模型层（Entity/EntityProp/EntityManager）、spi。
  - `ScalarKind`（`core/src/schema/scalar.ts:7-18`）：`"STR" | "I8" | "I16" | "I32" | "I64" | "F32" | "F64" | "NUM" | "DATE" | "BOOL" | "BINARY"`（string 字面量联合）。
  - `ScalarType<T>` class（`scalar.ts:16-60`）：构造器私有，static 工厂（`BOOL/DATE/I8..I64/F32/F64/NUM/str(length)/text()/binary(length)/image()`）。
  - `CascadeType`（`core/src/schema/join.ts:50`）：`"NONE" | "SET_NULL" | "DELETE" | "GRM_DELETE" | "GRM_SET_NULL"`（ORM 语义，含软删除）。
- `@ts-grm/sql`（`packages/sql`）：客户端、驱动、查询执行、schema 元数据。
  - **公开导出仅 5 个符号**（`sql/src/index.ts`）：`newSqlClient` + `SqlClientOptions/Filter/AnyFilter/FilterManager`。
  - schema 定义侧：`createSchema(sqlClient)`（`sql/src/impl/schema_creator.ts:9-11`，**内部模块，未导出**）→ `ReadonlyArray<TableDef>`。
  - 驱动：`Driver` 接口（`sql/src/driver/deriver.ts:8-27`）——`name/transactionManager/nodeRender/typeName(columnDef)/requiresInlineConstraints/isTableCascadeDeletionSupported/applyPagination`；**没有 exec/query**（执行在 `Executor`，`transaction/executor.ts:7-15`）。
  - 方言实现：`PostgresDriver` ✅ / `SqliteDriver` ✅ / `MySqlDriver` ✅；`sqlserver_driver.ts`、`oracle_driver.ts` 只有 nodeRender，**没有 Driver/typeName**。
  - 数据库驱动全部是 `devDependencies` + `peerDependencies`（`"*"`），**消费者自备**。

### 2.2 migrate 侧（骨架）

- `src/schema/model.ts`：语义层中间表示（`Schema/Table/Column/Constraint/Index`），列类型用**方言原生类型字符串**（如 `"bigint"`、`"varchar(50)"`）。
- `src/diff/types.ts`：`Diff/Change/AlterTable/ColumnChange/ConstraintChange/IndexChange` + `destructive` 子集。
- `src/differ.ts`：`SchemaDiffer` 骨架（空对空返回空，其余抛错）。
- `src/introspector.ts`：`Introspector` 接口 + `Dialect = "postgres"|"mysql"|"sqlite"|"mssql"|"oracle"`。
- `src/ddl.ts`：`DdlGenerator` 接口（`statements(diff)` + `createStatements(schema)`）。
- `src/store.ts` / `src/migrator.ts`：迁移历史与执行器接口（`MigrationStore` / `SqlExecutor` / `Migrator`，实现未做）。
- `src/vendor/ts-grm.ts`：ts-grm 唯一入口（目前仅 re-export `newSqlClient`/`SqlClientOptions`）。

## 3. 逐层对接分析

### 3.1 目标 schema 适配器（TableDef[] → migrate Schema）—— 已打通 ✅

migrate 的 `MigratorOptions.targetSchema` 需要「从模型推导的目标态 `Schema`」。ts-grm 侧对应物是 `createSchema()` 产出的 `TableDef[]`，**它就是目标 schema 的全部核心定义**（每张表 + 列 + 约束）。

**状态（2026-08-13 已解决）**：`createSchema` 此前未从包入口导出（`sql/src/index.ts` 仅 2 行导出），且包 `exports` 只开放 `"."`，node/vitest/tsc 三端实测均无法 import 子路径（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。已在 ts-grm 的 `sql/src/index.ts` 补导出：

```ts
export { createSchema } from "@/impl/schema_creator";
export type { TableDef, ColumnDef, ConstraintDef } from "@/impl/schema_def";
export type { SqlClientImplementor } from "@/sql_client";
```

（`SqlClientImplementor` 是 `createSchema` 的参数类型；`newSqlClient()` 运行时返回的实例即实现它，调用处 `as SqlClientImplementor` 即可。）已重建 dist 并在 migrate 侧验证 node/tsc/vitest 三端可达。

**适配映射**（`schema_def.ts:6-40` → `model.ts`）：

| ts-grm（TableDef/ColumnDef/ConstraintDef） | migrate（Schema/Table/Column/Constraint） | 备注 |
| --- | --- | --- |
| `TableDef.name` | `Table.name` | 保留字表名带引号（如 `"ORDER"`），适配层需去引号 |
| `TableDef.entity` / `.prop` | 无（普通表） | 中间表（m2m joinTable）归一化为普通表 |
| `ColumnDef.name` | `Column.name` | — |
| `ColumnDef.type: ScalarType` | `Column.type: string` | 经方言 `typeName()` 转换（见 3.2 的 bug 清单） |
| `ColumnDef.nullable` | `Column.nullable` | — |
| `ColumnDef.length` | 并入 `Column.type` | `str(length)` → `varchar(n)`（方言相关） |
| `ColumnDef.when`（多态适用实体） | 丢弃（列按 nullable 处理） | 多态归一化：见下 |
| `PRIMARY_KEY`（含 `implicit: "MIDDLE_TABLE"`） | `PrimaryKeyConstraint` | — |
| `FOREIGN_KEY`（`cascade: CascadeType`） | `ForeignKeyConstraint`（`onDelete` + `deferrable`） | CascadeType 需归一化：`DELETE→CASCADE`、`SET_NULL→SET_NULL`、`NONE→NO_ACTION`；`GRM_DELETE/GRM_SET_NULL` 在 core 源码中仅有类型定义、未见实现（预留值），适配层需与作者确认其数据库层面的动作；`deferrable` 模型侧无来源 → 默认 `false` |
| `UNIQUE`（`implicit: "ASSOCIATION"/"MIDDLE_ENTITY"`） | `UniqueConstraint` | 名字自动生成 → 内容匹配的 diff 可容忍 |
| `CHECK`（`column + values`，枚举检查） | `CheckConstraint`（expression） | 需拼成 `col IN (values)` 或按多态 discriminator 规则生成 |
| `INDEX` | （模型侧无来源） | 联合类型存在但 ts-grm 从未创建索引 |

**多态语义归一化**（README 已定的方向）：`when` 列 → 普通 nullable 列；discriminator 的 `CHECK` 约束可保留为 `CheckConstraint`（忠实于数据库实际），diff 按内容匹配。

**缺失能力（ts-grm 模型侧不表达）**：`ColumnDef` 没有 default / autoIncrement / comment 字段，也没有自定义索引。
→ migrate 目标态这些字段恒为空。**语义层陷阱**：diff 时「目标态无 default」会被解释成「删除现有 default」还是「不管理」？需要在 diff 语义里约定（建议：模型推导的目标态中，缺失的 `default/autoIncrement/comment` 视为「不管理」，与 introspection 侧「明确无」区分；或明确模型侧永远无法表达这些属性，diff 忽略模型侧缺失字段的删除类变更）。**这是开放决策点（见 §6）**。

> **作者路线确认（2026-08-13，已向作者求证）**：ts-grm 后续将添加**索引 / 默认值 / 主键生成策略**的配置能力，以及类似 Prisma 的 migrate 操作。
> 对 migrate 的含义：
> - 索引/默认值/主键生成策略：作者补齐后，模型侧直接产出这些信息（createSchema 的 TableDef 字段扩展），
>   migrate 的 `Schema` 字段早已预留（default/autoIncrement/comment/Index），适配器按「模型字段优先、
>   补充声明兜底」的优先级合并，**零破坏平滑接入**，补充声明机制随后可逐项退役；
> - 作者的 migrate 能力：如为完整迁移引擎，@ts-grm/migrate 需重新定位（共存/对齐/让位）；
>   如仅指建表/DDL 能力增强（toCreationStatements 方向），则正是我们条件复用的对象，越强越好。

### 3.2 方言能力接入（类型映射）

migrate 的 `Dialect` 是自己的概念（`introspector.ts:18-23`），与 ts-grm `Driver` 的对应：

- **有现成 Driver**：PG / SQLite / MySQL。
- **无 Driver**：MSSQL / Oracle（只有渲染器，无 `typeName`）。

**typeName() 现状问题（`postgres_driver.ts`、`mysql_driver.ts`，已核实）**：

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| `PostgresDriver.name` 返回 `"sqlite"` | `postgres_driver.ts:24-26` | 用 `driver.name` 判方言会错 |
| PG `NUM → "real"` | `postgres_driver.ts:300` | 数值精度丢失（应为 numeric/decimal） |
| PG `DATE` 无分支 | `typeName()` 无 case | 抛 `MetadataError`（建表 DATE 列直接挂） |
| PG `STR → "text"`，忽略 `str(length)` | `postgres_driver.ts:302` | `varchar(n)` 模型建出 text |
| MySQL `F32 → "flat"` | `mysql_driver.ts` | 拼写错误（应为 float） |

**建议**：migrate **自建「原生类型字符串 ↔ ScalarKind」映射表**，作为 introspection 解析与 DDL 生成的基础（`src/ddl.ts` 本就是独立实现，符合现有架构）；ts-grm 的 `typeName` 只作为模型侧初始值来源——**当前有 bug，不能直接依赖**（可推动作者修复，或 migrate 侧在 vendor 层修 wrapper 绕过）。另注意 `typeName` 入参是内部 `ColumnDef`（含 `prop/declaringTable`），从 introspection 文本重建成本高，进一步支持自建。

### 3.3 Introspector（数据库现状）

与 ts-grm **关系最小**：migrate 自己用 SQL 读 `information_schema`/`pg_catalog`（Postgres 起步），产出 migrate `Schema`。

- 可选复用：用户的 pg `Pool` 连接（若通过 `newSqlClient` 传入）——但 migrate 的 `SqlExecutor` 需要独立语义（迁移事务），不必耦合 ts-grm 连接管理。
- 反向归一化：introspection 读到的原生类型字符串（如 `"integer"`）如需与模型侧对齐，用 §3.2 的自建映射表反向解析成 ScalarKind（多对一，如 PG 的 `smallint/integer/bigint` 都是整型，diff 需要比较字符串原文而不是 kind —— 现有 `model.ts` 设计已如此）。

### 3.4 DDL 生成

- migrate 自建（`src/ddl.ts` 独立设计，方言差异集中点）。
- **借鉴**：`TableDef.toCreationStatements(driver)` / `toDeletionStatements(driver)`（`schema_def.ts:133-146`）——SQLite「重建表」路径和 PG 建表语句形态可参考，但入参是内部形状，**不直接复用**。

### 3.5 执行层（SqlExecutor / 事务）

- ts-grm 有 `PostgresTransactionManager`（`transaction/postgres_transaction_manager.ts:11-41`：pg Pool → begin/commit/rollback + 连接租借）和 `Executor.executeStatements(...)`。
- migrate 的 `SqlExecutor` 语义是「迁移事务」（一组语句 + 失败回滚 + advisory lock），与业务事务不同。
- **建议自建**（pg Pool 直连，几十行；advisory lock 是 migrate 特有需求，ts-grm 无对应物）。

### 3.6 store / migrator

纯 migrate 侧（迁移文件、历史表 `_migrations`、checksum、漂移检测、shadow database），**无 ts-grm 对接**。

## 4. ts-grm 已知问题清单（影响 migrate，需跟踪/上报）

1. ~~`createSchema` 未从 `src/index.ts` 导出~~ —— **已解决**（2026-08-13，补导出见 §3.1，发布时需包含）。
2. `PostgresDriver.name` 返回 `"sqlite"`（`postgres_driver.ts:24`）。
3. `typeName` 映射 bug：PG `NUM→real`、PG `DATE` 抛错、PG `STR` 丢长度、MySQL `F32→"flat"`（§3.2）。
4. 模型侧无 default / autoIncrement / comment / 自定义索引表达。
5. 保留字表名带引号（`"ORDER"`）。
6. MSSQL / Oracle 无 Driver / typeName。
7. 已修（勿回退）：`aggregate.ts:29` 多一个 `>`；`{core,sql}/package.json` 的 `exports.require` 指向 `index.cjs`（改指 `index.js`）——发布时需包含。
8. peer 警告（`mysql2` 需 `@types/node` 等）：不影响 migrate，不处理。

## 5. 分阶段实施建议

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **P0** | 定 `createSchema` 导出方案（上游导出 or 自建）；定目标态缺失字段语义（§6 决策点） | 需要作者协同（ts-grm） |
| **P1** | `src/vendor/ts-grm.ts` 扩展 + 适配器 `TableDef[] → Schema`（含多态归一化、CascadeType 映射）；自建「原生类型 ↔ ScalarKind」映射表 | P0 |
| **P2** | `SchemaDiffer` 实现（按内容匹配约束/索引、忽略列序、destructive 标注） | 纯 migrate |
| **P3** | Postgres `Introspector`（information_schema + pg_catalog，优雅报错） | 纯 migrate |
| **P4** | Postgres `DdlGenerator`（`statements` + `createStatements`） | P1 映射表 |
| **P5** | `MigrationStore`（文件 + 历史表）+ `Migrator`（事务、advisory lock、checksum、漂移检测、shadow/dry-run） | P2/P4 |
| **P6** | push 路径（无历史快速同步） | P5 |
| **P7** | 多方言：SQLite（重建表路径，借鉴 `toCreationStatements`）、MySQL（隐式提交） | P3/P4 结构就绪 |

P1→P5 完成后，可跑通第一个完整闭环：模型 → 目标态 → diff → DDL → 应用 → 历史记录。

## 6. 开放决策点

1. **目标态缺失字段语义**：模型侧无 `default/autoIncrement/comment`，diff 中如何解释（「不管理」 vs 「删除」）——建议「模型推导的目标态缺失 = 不管理」，需写进 diff 设计。
2. **typeName bug 谁修**：migrate 自建映射（推荐，不阻塞）vs 推动作者修 ts-grm（发布后仍会踩，迟早要修）。
3. ~~createSchema 导出~~ —— **已定**：上游导出（已在 ts-grm 补导出，见 §3.1）。
4. **执行层**：复用 ts-grm 事务管理 vs migrate 自建（推荐自建，见 §3.5）。
5. **方言范围**：首发只做 Postgres，还是与 ts-grm 的 PG/SQLite/MySQL 对齐。

---

### 附：关键源码位置速查

- `packages/core/src/schema/scalar.ts` — ScalarKind / ScalarType
- `packages/core/src/schema/join.ts:50` — CascadeType
- `packages/sql/src/index.ts` — 公开导出（缺 createSchema）
- `packages/sql/src/impl/schema_creator.ts` — createSchema
- `packages/sql/src/impl/schema_def.ts` — TableDef / ColumnDef / ConstraintDef
- `packages/sql/src/driver/{deriver,postgres_driver,sqlite_driver,mysql_driver}.ts` — Driver 与 typeName
- `packages/sql/src/transaction/` — TransactionManager / Executor
- `src/schema/model.ts`（migrate）— 语义中间表示
- `src/vendor/ts-grm.ts`（migrate）— ts-grm 唯一入口
