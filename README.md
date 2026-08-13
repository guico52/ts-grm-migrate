# @ts-grm/migrate

ts-grm 的 schema 迁移引擎（起点骨架，尚未实现核心逻辑）。

## 目标

为 [ts-grm](https://github.com/ts-grm)（TypeScript ORM，Jimmer 移植）提供类似
Prisma Migrate 的能力，分两阶段：

1. **增量迁移（migrate）**：introspection → diff → 增量 DDL → 迁移历史 → 按序应用
2. **无历史快速同步（push）**：diff 后直接应用，不记录历史

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

## 与 ts-grm 的对接

### 依赖接入（已完成）

- **工具链**：与 ts-grm 对齐，使用 yarn 4（`packageManager: yarn@4.1.0`，`nodeLinker: node-modules`）
- **引用方式**：yarn workspace 跨目录挂载 ts-grm 的 `packages/*`，用 `workspace:*` 协议引用 `@ts-grm/sql`。
  以后 ts-grm 发布 npm 后，只需把 `workspace:*` 换成版本号，其余零改动
- **安装**：
  ```sh
  # 1) 先构建 ts-grm（dist 是 runtime 入口）
  cd /home/guico/code/source/ts-grm && corepack yarn install
  corepack yarn workspace @ts-grm/core build
  corepack yarn workspace @ts-grm/sql build
  # 2) 本仓库
  cd /home/guico/code/open-source/ts-grm-migrate && corepack yarn install --mode=skip-build
  ```
  `--mode=skip-build` 跳过 ts-grm 各包 devDeps 中数据库驱动的 node-gyp 编译（migrate 不需要它们）

#### 发布后的切换（待 ts-grm 发布 npm 后执行）

- 把 `package.json` 的 `"@ts-grm/sql": "workspace:*"` 换成 npm 版本号，并删除 `workspaces` 挂载
- **改名风险**：ts-grm 作者很可能在发布时修改包名。代码层面已做隔离——所有 `@ts-grm/*`
  import 必须集中在 `src/vendor/ts-grm.ts` 适配层（唯一修改点）；更换包名/版本时只需改该文件
  与 `package.json`，业务代码零改动

### API 适配点（未接入，待 migrate 核心逻辑实现）

- **目标 schema 来源**：ts-grm 的 `createSchema()`（`packages/sql/src/impl/schema_creator.ts`）
  产出 `TableDef[]`，需要适配为 `Schema`；多态语义（`when` 列、implicit 约束）在适配层归一化
- **方言能力**：ts-grm 的 `Driver`（`packages/sql/src/driver/`）已有 `typeName()` 等，
  需要扩展 introspection / DDL 生成；`PostgresDriver` 尚有几个已知问题（`name` 返回 "sqlite"、
  类型映射缺长度、keywords 混入 SQLite 词）

### 对接过程中对 ts-grm 的修复（已与作者确认）

- `packages/core/src/dsl/aggregate.ts:29`：`NumExpression<number>>` 多一个 `>`（JS 语法错误，
  导致 core 无法构建），已删除，恢复为 HEAD 状态
- `packages/{core,sql}/package.json`：`exports.require` 指向不存在的 `./dist/index.cjs`，
  实际 cjs 产物是 `./dist/index.js`，已修正（require 消费者此前必挂）

## 参考学习笔记

- Prisma 迁移引擎源码：`~/code/open-source/prisma-engines`
- 精读顺序：`database_schema.rs` → `sql_schema_differ.rs` → `libs/sql-ddl/src/postgres.rs`
  → `sql_migration_persistence.rs` → `apply_migration.rs` → 命令层
- 替代参考：drizzle-kit（TS，与 ts-grm 同构）、atlas（Go）

## 状态

骨架 + 类型草案，`SchemaDiffer.diff` / `Migrator.deploy` 等未实现。
下一步候选：Postgres Introspector（information_schema + pg_catalog）。
