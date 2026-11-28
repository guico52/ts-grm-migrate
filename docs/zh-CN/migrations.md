# 审核与应用迁移

[English](../migrations.md) | 简体中文

可以从空数据库生成初始迁移，也可以通过 `baseline` 接管受支持的存量表，并明确表管理范围。模型需要自行提供，暂不支持从数据库反向生成模型。

## 接管存量数据库与忽略表

```ts
export default defineConfig({
  dialect: 'postgres',
  database: { connectionString: process.env.DATABASE_URL },
  models: ['./src/models'],
  excludeTables: ['sys_*', /^archive_\d{6}$/, 'external_users'],
});
```

`excludeTables` 接受 `(string | RegExp)[]`，匹配当前数据库/schema 内的**物理表名**。字符串使用完整表名 glob，默认区分大小写；RegExp 遵循 JavaScript 原生语义，可使用 `i` 忽略大小写，需要完整匹配时写 `^`、`$`，不允许有状态的 `g`、`y` flags。多个模式任意命中即排除。被排除表不参与 `dev`、`push`、`check` 及部署后的 drift 检查，且在解析不支持的特殊结构前过滤。被排除表可以保留在模型中供应用查询，tgm 不检查它们是否存在或结构是否一致，也不会根据模型创建缺失的被排除表；迁移历史表始终保留。未被排除的表保持原有权威比较：删除模型或发现数据库中无模型的表仍会报告 drift，但只有显式设置 `allowDropTables: true` 才会自动生成删表。

字符串 glob 支持 `sys_*`（前缀）、`*_log`（后缀）、`report_????`（四个字符）、`report_[0-9][0-9]`（两位数字）、`{order,payment}_*`（前缀任选）。`*`、`?` 不跨 `/`；表名按字符串处理，不展开目录，`sys_**` 与 `sys_*` 等价。不支持以 `!` 否定规则或 extglob；字符串中的括号和竖线按字面量处理，复杂条件请直接使用 RegExp。要匹配字面的 `*`，TypeScript 字符串写成 `'sys_\\*'`。不平衡的字符集合或花括号会在操作前报错。

```ts
excludeTables: [
  'sys_*',                       // 所有系统表
  /^order_(?:2025|2026)_\d{2}$/, // 旧系统维护的按月分表
  /^tenant_\d+_audit$/i,         // 租户审计分表
]
```

后续新建且命中规则的物理分表也会自动被忽略。模式只决定表的管理范围，不会把一个逻辑模型展开成多个物理分表，也不提供分片路由。分库场景应为各数据库分别配置连接，并独立运行迁移；模式不匹配数据库名或 schema 名。

1. 编写与待接管表匹配的 ts-grm 模型，配置不接管的表。
2. 运行 `npx tgm check`，对齐报告的差异。
3. 在迁移目录及迁移历史为空时运行 `npx tgm baseline -n initial`。
4. 提交模型、配置及生成的 SQL。后续正常使用 `dev --create-only`、审核、`deploy`。

`baseline` 从受管理的数据库现状生成可在空库创建这些表的 SQL，保留可表达的默认值与独立索引，并将文件记录为已应用；不执行业务建表 SQL、不修改业务数据。它会初始化迁移历史表。结构与模型的受管理属性存在差异、没有受管理表或已有迁移文件/历史时拒绝接管。它只支持当前 introspector/DDL 能表达的结构，不导出业务数据、触发器、视图、自定义函数等数据库对象；涉及这些对象或自定义默认值依赖时，需单独准备初始化 SQL。PostgreSQL serial 在重放文件中用 identity 表达，自增计数和其他序列参数不会复制。

在空的新环境执行 `deploy`，会实际应用基线文件；忽略表由其拥有者预先创建。其他已有相同结构的环境，应先用相同配置运行 `check`，审核并确认基线 SQL 对应现状，再用 `resolve --applied <基线ID>` 标记。若首次接管写历史失败，文件会保留；确认数据库结构及历史状态后可用相同方式恢复，不应直接部署该建表文件到存量库。

首版保守限制跨范围外键：受管理表引用被排除表时拒绝比较和接管；被排除表引用受管理表时允许无差异检查与基线，但拒绝对被引用表生成结构变更，需先人工处理依赖。自定义 `Introspector` 必须支持 `IntrospectionOptions` 的提前过滤与 `onExcludedReference` 回调。

排除配置不会重写已有迁移 SQL。`deploy` 仍按文件执行，包括手写 SQL；变更排除范围时必须审核待应用文件。新增排除项不会删除既有文件或历史，取消排除意味着重新参与完整比较。

## 控制自动删表

本配置从 `0.1.0-alpha.9` 起提供；`baseline` 与模式排除从 `0.1.0-alpha.8` 起提供。已发布的 `0.1.0-alpha.9` 默认值为 `true`，下一未发布版本改为 `false`。升级后若需保留自动删表行为，请显式设置 `allowDropTables: true`。

```ts
export default defineConfig({
  database: { connectionString: process.env.DATABASE_URL },
  models: ['./src/models'],
  allowDropTables: false,
});
```

`allowDropTables` 为布尔值，下一未发布版本起默认 `false`，只有显式设为 `true` 才允许自动删表。省略或设为 `false` 时，`dev`（含 `--create-only`）和 `push`（含 `--dry-run`）会从生成的 SQL 及破坏性确认列表中移除删表操作。建表、加列、删列、约束与索引变更仍然有效，`--force` 不会覆盖该设置。直接构造 `Migrator` 时也可传入同名选项。

该配置控制 DDL 生成，不改变管理范围。`check` 及应用后的 drift 检查仍会报告未被排除但模型中不存在的表；这些差异保留时 `push` 返回 1。仅有删表差异时，`dev` 报告差异，不生成空迁移。`baseline` 仍要求受管理结构与模型一致，不会自动把多余表纳入基线。如果希望这些表完全不参与管理，请使用 `excludeTables`。

已有 SQL 不会被重写：即使设置 `allowDropTables: false`，`deploy` 仍会执行迁移文件中已有的 `DROP TABLE`。保留表继续参与 DDL 依赖上下文，确保变更被引用的键后能恢复外键；数据库依赖约束及现有的跨管理范围外键保护仍然有效。

## 生成、审核、应用

```sh
npx tgm dev --create-only -n init
# 审核 migrationsDir 中生成的 SQL，必要时编辑。
npx tgm deploy
npx tgm check
```

`--create-only` 只写一个待应用 SQL 文件，不执行其中的 SQL，也不创建迁移历史。连接初始化仍可能创建目标 schema 或空 SQLite 文件。由于不会应用变更，此模式不要求破坏性变更确认。务必在 `deploy` 前审核 SQL：部署会直接应用待处理文件，不进行交互确认。

`dev` 和 `dev --create-only` 都会检查已应用文件的 checksum 及文件缺失。有待应用文件时拒绝继续生成迁移，需先执行 `deploy`。拉取同事的迁移后也遵循这一流程。应用后不要编辑历史文件，应另建迁移。

不带 `--create-only` 的 `dev` 仍会立即生成并应用迁移。`push` 同步当前模型管理范围内的结构，不写历史。存在待应用、失败、缺失或被修改的迁移时拒绝同步，需先处理迁移工作流。`push --dry-run` 只预览 SQL，不创建 schema、不修改数据库或历史；SQLite 要求文件已存在。已应用迁移必须构成按文件顺序排列的连续前缀。在 `push` 实验后需要建立可重放的历史时，可在数据库与模型一致、迁移文件及历史均为空时运行 `baseline`。

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
