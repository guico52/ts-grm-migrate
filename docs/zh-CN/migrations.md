# 审核与应用迁移

[English](../migrations.md) | 简体中文

本工具面向新的 ts-grm 应用：从空数据库生成初始迁移，再通过后续模型变更演进数据库。接管既有应用数据库、从数据库反向生成模型，以及为既有表建立 baseline，均不属于当前支持范围。

## 生成、审核、应用

```sh
npx tgm dev --create-only -n init
# 审核 migrationsDir 中生成的 SQL，必要时编辑。
npx tgm deploy
npx tgm check
```

`--create-only` 只写一个待应用 SQL 文件，不执行其中的 SQL，也不创建迁移历史。连接初始化仍可能创建目标 schema 或空 SQLite 文件。由于不会应用变更，此模式不要求破坏性变更确认。务必在 `deploy` 前审核 SQL：部署会直接应用待处理文件，不进行交互确认。

`dev` 和 `dev --create-only` 都会检查已应用文件的 checksum 及文件缺失。有待应用文件时拒绝继续生成迁移，需先执行 `deploy`。拉取同事的迁移后也遵循这一流程。应用后不要编辑历史文件，应另建迁移。

不带 `--create-only` 的 `dev` 仍会立即生成并应用迁移。`push` 同步当前模型管理范围内的结构，不写历史。存在待应用、失败、缺失或被修改的迁移时拒绝同步，需先处理迁移工作流。`push --dry-run` 只预览 SQL，不创建 schema、不修改数据库或历史；SQLite 要求文件已存在。已应用迁移必须构成按文件顺序排列的连续前缀。在 `push` 实验后需要建立可重放的历史时，请改用新的空数据库生成初始迁移。

## 自定义 SQL 与无法自动生成的变更

可以直接向 `migrationsDir` 添加 SQL 文件，包括仅修改数据的迁移。ID 必须唯一，且按字典序排在所有现有迁移之后，通常使用 17 位 UTC 时间戳加名称：

```text
<migrationsDir>/20261009080000000_backfill.sql
```

这是示例 ID，实际应选择新的时间戳并通过 `tgm status` 检查顺序。模型和迁移文件应一起提交 Git。文件名去掉 `.sql` 就是 `resolve` 使用的迁移 ID。

PostgreSQL 文本转整数时，可以先执行 `dev --create-only`，再为生成的语句补充明确的转换方式：

```sql
alter table "item" alter column "quantity" type integer
  using "quantity"::integer;
```

向有数据的表添加非空列时，应按业务需要分阶段处理：先添加可空列，再回填数据，最后设置 `NOT NULL`。重命名时，更新模型后将生成的删除和新增语句替换为保留数据的显式 rename SQL。

SQLite 重建表以及 PostgreSQL / SQL Server / Oracle identity 切换等变更，会在生成文件之前被拒绝。此时手工创建 SQL 文件，再通过 `deploy` 应用。安全的 SQLite 重建必须保留数据、外部外键、索引和触发器；identity 变更需要处理已有值和生成器的下一个值。自定义 SQL 应在已应用前序迁移的隔离数据库中验证。

如果 SQL 已手工执行，创建对应文件后运行：

```sh
npx tgm resolve --applied 20261009080000000_backfill
npx tgm check
```

`resolve --applied` 记录文件及其 checksum，不执行也不验证其中的 SQL。

## 失败恢复与事务

PostgreSQL、SQLite 和 SQL Server 在 SQL 执行或成功记录写入失败时，自动回滚当前迁移事务。每个迁移文件是独立事务：后续文件失败不会撤销此前已成功应用的文件。执行前持久化的未完成记录，即使事务回滚成功也会继续阻止自动重放，需明确恢复。

MySQL 和 Oracle 的 DDL 隐式提交，失败文件中此前执行的语句可能仍然生效。使用 `resolve` 前先确认实际状态。手工完成迁移后使用 `resolve --applied`；已撤销其影响时使用 `resolve --rolled-back`，再重试 `deploy`。`resolve --rolled-back` 只修改历史，不撤销 SQL。工具不提供撤销已经成功迁移的自动逆向操作。

## 管理范围与检查

模型中的表、列和约束是权威目标态。未使用 `ts-grm-patches` 时不管理默认值和自增；使用补丁后这两个属性也成为权威目标态。独立索引和注释没有模型声明来源，不参与模型同步管理。通过自定义迁移添加的独立索引，在其列仍存在时会保留。程序化 Schema 可以通过 `indexesManaged: true` 明确管理索引；删除 unique index 会被标为可能有破坏性的变更。

```sh
npx tgm check       # 0：模型一致；1：有差异或发生错误
```

`check` 读取数据库，不创建 schema、不修改业务表、不写迁移历史；SQLite 要求指定文件已存在。`dev`、`deploy` 对残留 drift 给出警告。`push` 同步后仍有结构差异时返回 1；取消操作也返回 1。CHECK 差异也会报告，不会把未经证明的表达式等价性直接当作已知噪声忽略。保守比较可能报告语义等价的表达式，需要人工判断，不能把每条警告都理解为迁移失败。

本项目主动不使用影子库。重放第二个数据库会增加实例准备、权限、执行时间和多方言管理成本，不符合轻量 ORM 辅助工具的定位。现有检查覆盖已应用文件完整性和数据库与模型的差异，不证明迁移历史能完整重建当前数据库。发布前应自行在隔离的空数据库中应用完整历史进行验证。

支持的 CHECK 表达式能够在 catalog 格式变化后正确读回；其他表达式保守比较。SQLite 保留 NUMERIC 与 REAL affinity 的区别，读取 CHECK 和部分索引谓词，删除表时先删引用方。循环依赖的删表计划会被拒绝。模型不管理的特殊索引保留，但会改写其列或管理这些索引的操作会被拒绝。生成列、隐藏列及不支持的约束语义会明确报错，不会被降级成普通结构。

本地锁使用 `proper-lockfile` 的原子目录与续期租约，进程崩溃后残留租约在 10 秒后过期。PostgreSQL 在同一 session 持锁并执行所有工作。SQLite 文件库额外按真实文件路径加锁，覆盖不同 checkout；原生 better-sqlite3 会自动提供文件名；没有 `name` 的程序化包装器须在 `SqliteSqlExecutor` 第二个构造参数传入数据库文件路径。不要手动删除仍被持有的租约目录。
