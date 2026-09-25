# 设计

[English](../design.md) | 简体中文

使用方法和数据库限制见 [README](README.md)。这里记录代码的主要边界，便于修改迁移行为时找到对应模块。

## 从模型到 SQL

`src/runtime.ts` 同时组装 CLI 和程序化入口。它加载 `models`，创建 ts-grm 的 `SqlClient`，再将模型转换成迁移器使用的 `Schema`：

```text
ts-grm models → src/vendor/ts-grm.ts → src/schema/adapter.ts → Schema
                                                       ↕
database → introspector → Schema → differ → DDL generator → executor
                                                       ↕
                                              migration files / history
```

`src/vendor/ts-grm.ts` 是唯一读取上游内部 `tableDefs` 的位置。上游公开的 `Schema` 类型没有结构化表定义，因此这个适配点需要随 peer 版本验证。`src/dialect.ts` 集中维护方言名称和支持状态；具体的读取、DDL 与执行逻辑分别放在 `src/introspector/`、`src/ddl/` 和 `src/executor/`。

ts-grm 的模型注册表是进程级单例。CLI 在独立进程中加载模型，程序化使用时应避免在同一进程中混用互不相关的模型集合。

## 差分规则

数据库现状和模型目标都转成 `Schema` 后，由 `src/differ.ts` 比较。列按名字匹配；约束和索引按内容匹配，因为数据库或 ts-grm 生成的名字不一定稳定；列顺序不参与比较。

模型没有提供的列默认值和注释不由迁移器删除。模型无法表达的自增策略目前也不参与差分；约束和索引则以目标态为准。模型的多态字段在适配时转换成普通列和数据库约束，之后不再保留 ts-grm 的模型语义。

SQLite 读取不到约束名，因此按内容比较尤其必要。部分 CHECK 表达式在数据库中会被重新格式化；等价表达式仍可能被判定为变更。需要扩大归一化范围时，应先补对应方言的真实数据库测试。

## 迁移与恢复

`src/migrator.ts` 管理 `dev`、`deploy`、`push` 和 `resolve`。迁移文件使用独占创建，并用 checksum 检查已应用文件是否被修改。执行前先写入未完成记录；进程中断或记账失败后，后续部署不会自动重放，需先检查数据库，再使用 `resolve`。

同一项目的本地并发由 `src/lock.ts` 的进程锁限制，跨机器并发由数据库锁限制。PostgreSQL、SQLite 和 SQL Server 把迁移 SQL 与成功记录放在同一事务中。MySQL 和 Oracle 的 DDL 可能隐式提交，失败后必须根据实际数据库状态决定如何恢复。

`src/drift.ts` 在迁移后再次读取数据库，并比较它与当前模型。它不重放全部迁移文件，因此不能证明历史文件与数据库从未发生偏离；已应用文件的 checksum 检查覆盖的是文件修改。

SQLite 需要重建表的变更目前明确报错。安全重建还需要处理外部外键、索引及数据搬迁，不能仅靠把旧表改名解决。其他方言的结构限制见 [README](README.md#数据库支持与配置)。

## 验证修改

运行 `corepack yarn check` 做静态检查、构建和本地测试。数据库测试使用 `corepack yarn test:postgres-mysql` 和 `corepack yarn test:servers`；没有相应数据库环境时，普通测试会跳过这些用例。版本范围的验证步骤见 [兼容性](compatibility.md)。
