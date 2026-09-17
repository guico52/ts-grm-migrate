# @ts-grm/migrate

ts-grm 的 schema 迁移引擎（ts-grm 插件）。

## 目标

为 [ts-grm](https://github.com/ts-grm)（TypeScript ORM，Jimmer 移植）提供类似
Prisma Migrate 的能力，分两阶段：

1. **增量迁移（migrate）**：introspection → diff → 增量 DDL → 迁移历史 → 按序应用
2. **无历史快速同步（push）**：diff 后直接应用，不记录历史

## 用法（CLI）

装上依赖后（包提供 `ts-grm-migrate` 可执行文件），在项目根放一个配置文件：

```ts
// ts-grm-migrate.config.ts
import { defineConfig } from "@ts-grm/migrate";

export default defineConfig({
  database: { host: "localhost", database: "app", user: "postgres" },
  models: ["./src/models"], // 交给 EntityManager.of 加载（.ts 或编译后的 .js）
  // 可选：migrationsDir（默认 ./src/ts-grm）、schema（默认 public）、lockPath
});
```

然后：

```sh
ts-grm-migrate dev --name init    # 对比模型与数据库，生成并应用一个迁移
ts-grm-migrate deploy             # 应用所有未应用的迁移（部署 / CI）
ts-grm-migrate push [--force]     # 直接同步成模型的样子，不写文件、不记历史
ts-grm-migrate status             # 查看已应用 / 待应用
ts-grm-migrate resolve --applied <id>       # 标记为已应用（SQL 已手工执行过）
ts-grm-migrate resolve --rolled-back <id>   # 清除失败记录，让它重新待应用
```

命令名可用简写 **`tgm`**（与 `ts-grm-migrate` 等价）。

选项：`--config <path>`、`--force`、`-h`。

- 迁移文件是 `<migrationsDir>/<时间戳>_<名字>.sql`，**人可读、可手工编辑**；
  已应用的迁移文件不能再改（checksum 漂移检测会拒绝继续）
- 破坏性变更（删表 / 删列 / 改列类型）默认交互确认，非交互环境需显式 `--force`
- 每次 `dev` / `deploy` / `push` 之后自动**对账**（`src/drift.ts`）：再读一次数据库与模型
  比对，仍有差异就指出「哪个库、哪张表、差在哪」（如「表 AUTHOR：多出列 LEGACY」）。
  用于发现迁移未完整生效、或数据库被手工改动的情况
- `schema` 同时作用于 introspect 与 DDL 执行（连接池 `search_path`），
  非 `public` 时自动创建

## 分层（对应 prisma-engines 的源码结构）

| 本模块 | 职责 | prisma-engines 参考 |
| --- | --- | --- |
| `src/schema/model.ts` | 数据库 schema 中间表示 | `schema-engine/connectors/sql-schema-connector/src/database_schema.rs` |
| `src/differ.ts` | 语义层 diff（方言无关） | `.../sql_schema_differ.rs` |
| `src/introspector.ts` | 读取数据库现状（每方言一个实现） | `.../introspection.rs` + `schema-engine/sql-schema-describer/` |
| `src/ddl.ts` | 语义 diff → 方言 SQL | `libs/sql-ddl/src/postgres.rs` + `.../sql_renderer.rs` |
| `src/store.ts` | 迁移文件 + 历史表（`_migrations`） | `.../sql_migration.rs` / `sql_migration_persistence.rs` |
| `src/migrator.ts` | 迁移应用器（deploy/dev） | `.../apply_migration.rs` + `commands/apply_migrations.rs` |

## 设计决策（已定，见各文件注释）

- **判别联合 + 类型守卫**，不用 type-erasure downcast（对应 TS 对 Prisma Rust 模式的改进）
- **语义层 / 语法层分离**：diff 方言无关，DDL 生成方言化
- diff **忽略列顺序**；约束/索引按内容匹配而非名字
- **破坏性操作可识别**（`Diff.destructive`），供 CLI 确认 / data-loss 警告
- introspection 是外部输入路径：错误处理优雅报错，绝不 fail-fast
- PG 的 DDL 可事务：每个迁移一个事务 + advisory lock 防并发
- **定位：开发期工具**。在开发者机器上作为独立进程运行，用 `EntityManager.of()` 加载
  使用者的全部 model，据此管理数据库版本；因此与宿主共享同一份 ts-grm 实例
  （peerDependencies），而非自带一份
- **一个项目 = 一套模型集合**，不支持 monorepo / 同目录塞多个后端：数据库对接是单个
  后端程序的事。CLI 因此只需一个模型根目录，不需要集合隔离机制；模型重名由上游
  `StateError` 直接抛出，按使用者错误处理
- **并发防护用进程锁文件**：migrate 每次运行是独立进程（`ALL_MODEL_MAP` 天然干净），
  用项目级锁文件阻止同一项目上同时运行多个实例，避免迁移与 DDL 交叉

## 与 ts-grm 的对接

### 依赖接入（已完成）

`@ts-grm/core` / `@ts-grm/sql` 声明为 **peerDependencies**（`^0.0.13`），本地开发由
devDependencies 提供同一版本 —— migrate 是 ts-grm 的插件，宿主由使用者提供：

```sh
corepack yarn install
```

**为什么必须是 peer 而不是 dependencies**：ts-grm 的模型注册表是**模块级单例**。
`model()` 在构造时把自己写进 `ALL_MODEL_MAP`（`packages/core/src/impl/model_impl.ts:57`），
`EntityManager.of()` 取值时遍历的也是这个全局 map（`packages/core/src/schema/entity_manager.ts:75`）。
若 migrate 自带一份 `@ts-grm/core`，它看到的是**空注册表**，拿不到使用者定义的任何 model。
同理，CJS `require` 与 ESM import 混用也会分裂成两份（实测 `ESM !== CJS`），
因此 `@ts-grm/*` 一律走 **ESM import** —— 见 `tests/util/ts-grm-client.ts`。

- **上游 API 隔离**：所有 `@ts-grm/*` import 集中在 `src/vendor/ts-grm.ts`（唯一修改点）。
  上游改名 / 改 API 时只需改该文件与 `package.json`，业务代码零改动。

#### 上游 API 现状（0.0.13）与适配点

上游把 schema 定义收回了内部模块：公开导出里**没有** `createSchema` / `TableDef` /
`ColumnDef` / `ConstraintDef` / `SqlClientImplementor`。

- 结构化表定义唯一的公开入口是 `sqlClient.createSchema()`，但它的**公开类型**（core 的
  `Schema`）只暴露 `creationSqlArray` / `deletionSqlArray` / `execute` / `toString`
  —— 只有 SQL 字符串，而 diff 需要结构。
- 该调用的运行时返回值（上游内部的 `SchemaImpl`）带 `tableDefs: TableDef[]`。
  `src/vendor/ts-grm.ts` 的 `createSchema()` 是全仓库**唯一**读取该内部字段的地方；
  上游一旦公开结构化 API，只需替换这一个函数。
- `TableDef` / `ColumnDef` / `ConstraintDef` 上游未导出，vendor 层按 dist 类型声明镜像
  （结构等价，子类型引用 core 的公开类型，不引入 `any`）。

### 获取使用者定义的 model（机制已查清）

ts-grm 的模型发现是**全局注册 + 按需加载**两步：

1. **注册**：`model(...)` 构造 `ModelImpl` 时即写入模块级 `ALL_MODEL_MAP`
   （`packages/core/src/impl/model_impl.ts:57-60`，重名抛 `StateError`）。
2. **加载**：`EntityManager.of(baseDir, ...modelPaths)`（`packages/core/src/schema/entity_manager.ts:59`）
   递归 `import()` 指定路径下的 `.js` / `.ts` 触发注册；随后 `entities()` 遍历的是
   **全局 `ALL_MODEL_MAP`**（而非扫描结果），再由 `_add` 展开继承与关联
   （superEntity / targetEntity / middleEntity）。

所以 `EntityManager.of(模型目录)` 是 migrate 拿到「使用者全部 model」的公开入口
（`ALL_MODEL_MAP` 本身未导出）。实测：只传一个模型文件路径，同进程内任何位置定义、
未参与扫描的 model 也会被一并带上。

这带来一条设计约束：**同进程内多套模型集合会互相污染**。migrate 的定位是开发期独立
进程工具（每次运行 `ALL_MODEL_MAP` 天然干净），并用**进程锁文件**保证同一项目上不会
并发运行多个实例，因此该问题在实际用法下不出现。

**明确不支持 monorepo / 同目录多后端** —— 一个项目就是一套模型集合，所以 CLI 只需一个
模型根目录；模型重名由上游 `StateError` 直接抛出，按使用者错误处理，不做集合隔离。

### 目标 schema 来源（已接入）

`tableDefsToSchema()`（`src/schema/adapter.ts`）把上游 `TableDef[]` 适配为 migrate 的
`Schema`：表名去引号、`CascadeType` → `ON DELETE` 归一化、CHECK 表达式还原；
多态语义（`when` 列、implicit 约束）在适配层归一化。

待办：`default` / `comment` / 索引在模型侧无来源，需补充声明机制填充。

### 方言能力（待办）

- ts-grm 的 `Driver` 已有 `typeName()`，introspection 与 DDL 生成需要扩展
- `PostgresDriver` 尚有几个已知问题（`name` 返回 "sqlite"、类型映射缺长度、
  keywords 混入 SQLite 词）

### 对 ts-grm 的修复（历史，已随上游更新失效）

骨架期曾在本地 ts-grm 仓库打过三个补丁（`aggregate.ts` 语法错误、`package.json` 的
`exports.require`、`sql/src/index.ts` 补导出 schema 定义）。上游仓库更新后这些改动已被覆盖，
**migrate 不再依赖它们**：

- `exports.require`：上游现在直接产出 `./dist/index.cjs`，问题自然消失
- schema 定义导出：上游已确认不再公开，改由 vendor 层适配（见上「上游 API 现状」）

## 参考学习笔记

- Prisma 迁移引擎源码：`~/code/open-source/prisma-engines`
- 精读顺序：`database_schema.rs` → `sql_schema_differ.rs` → `libs/sql-ddl/src/postgres.rs`
  → `sql_migration_persistence.rs` → `apply_migration.rs` → 命令层
- 替代参考：drizzle-kit（TS，与 ts-grm 同构）、atlas（Go）

## 状态

**已实现**：

- 语义层 IR（`schema/model.ts`）、目标态适配（`schema/adapter.ts`）
- 快照序列化与校验（`snapshot.ts`）
- diff 引擎（`differ.ts`）
- 双方言 DDL 生成（`ddl/postgres.ts`、`ddl/sqlite.ts`）
- Postgres Introspector（`introspector/postgres.ts`）：从 pg_catalog 读表 / 列 / 主键 /
  唯一 / 外键 / CHECK / 索引；类型串与 ts-grm `typeName()` 对齐（见该文件头注释）
- 迁移存储（`store.ts`）：磁盘 `<id>.sql` 文件 + 数据库 `_migrations` 历史表
- 迁移应用器（`migrator.ts`）：`deploy` / `dev` / `push`；进程锁 + database advisory lock、
  checksum 漂移检测、每个迁移一个事务、失败记入历史；diff 时自动剔除历史表
  （否则会被当成业务表 DROP）
- 对账（`drift.ts`）：迁移之后再确认一次「数据库 == 模型」，把差异转成可读报告
  （`deploy` / `dev` / `push` 自动调用，也可用 `migrator.checkDrift()`）
- 进程锁文件（`lock.ts`）、Postgres 执行器（`executor/postgres.ts`，只依赖结构接口，
  不把 pg 当运行时依赖）
- **CLI**（`cli.ts` + `config.ts` + `runtime.ts`）：`dev` / `deploy` / `push` / `status` /
  `resolve`，配置文件驱动、破坏性变更交互确认；与程序化调用共用同一条组装链

测试 **132 用例通过**，含真实 Postgres 的 introspection / 端到端迁移 / CLI 套件
（`tests/*-postgres.test.ts`、`tests/cli-postgres.test.ts`、`tests/manual-postgres.test.ts`，
无 `PG_HOST` 时自动跳过）。`tsc --noEmit` 零错误。

**已知限制**（introspection）：

- CHECK 的表达式原文由 PG deparse（`((col)::text = ANY (ARRAY[...]))`），与模型侧适配器
  还原的写法不同，diff 会判为变化并 drop+add；归一化留待后续
- 暂不处理分区表与排他约束

**未实现**：SQLite 尚无 introspector 与 executor；shadow database（应用前在临时库试跑）未做。

下一步候选：SQLite 方言（introspector + executor）。
