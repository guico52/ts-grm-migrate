/** Paired diagnostic templates. Values such as paths, SQL and identifiers are not translated. */
export const diagnostics = {
  model_load: { en: 'Failed to load models: {0}', 'zh-CN': '加载模型失败：{0}' },
  model_module: {
    en: 'Failed to load models: {0}\nHint: migrations load model files through Node\'s native import. Use ESM (set "type": "module") or point models to compiled ESM .js files.',
    'zh-CN':
      '加载模型失败：{0}\n提示：迁移工具通过 Node 原生 import 加载模型。请使用 ESM（在 package.json 中设置 "type": "module"），或将 models 指向编译后的 ESM .js 文件。',
  },
  model_missing: {
    en: 'Failed to load models: {0}\nHint: Check models paths, imports within the models, and installed dependencies.',
    'zh-CN': '加载模型失败：{0}\n提示：请检查 models 路径、模型内的 import 路径及已安装的依赖。',
  },
  model_naming: {
    en: 'Failed to load models: {0}\nHint: Model names must use PascalCase (for example SysUser); configure database table names separately.',
    'zh-CN':
      '加载模型失败：{0}\n提示：模型名称与数据库表名是不同的设置。若要保留表名 sys_user，可在模型的配置回调中使用 ctx.table("sys_user")。',
  },
  config_hint_module: {
    en: '\nHint: The nearest package.json determines the module type of a `.ts` configuration file. For CommonJS projects, rename the file to `.mts` or set "type": "module" in package.json.',
    'zh-CN':
      '\n提示：最近的 package.json 决定 .ts 配置文件的模块类型。CommonJS 项目可将配置文件改为 .mts，或在 package.json 中设置 "type": "module"。',
  },
  config_hint_missing: {
    en: '\nHint: An import in the configuration file cannot be resolved. Check installed packages and paths in {0}.',
    'zh-CN': '\n提示：配置文件中的 import 无法解析，请检查已安装的依赖和 {0} 中的路径。',
  },
  migrator_record_failure: {
    en: 'Migration "{0}" failed: {1}; recording the failure also failed. The incomplete state remains.',
    'zh-CN': '迁移 "{0}" 执行失败：{1}；记录失败状态也失败：{2}。未完成状态仍然保留。',
  },
  migrator_started: {
    en: 'Migration started but did not finish; inspect the database and use resolve to recover.',
    'zh-CN': '迁移已开始但尚未完成；请检查数据库，并使用 resolve 恢复状态。',
  },
  dialect_1: {
    en: 'Unknown dialect "{0}". Known dialects: {1} (implemented: {2}).',
    'zh-CN': '未知方言 "{0}"。可选方言：{1}（已实现：{2}）。',
  },
  config_1: {
    en: 'Configuration file not found. Create one of these files in the project root:\n  {0}',
    'zh-CN': '未找到配置文件。请在项目根目录创建以下任一文件：\n  {0}',
  },
  config_2: {
    en: 'Failed to load configuration file "{0}": {1}{2}',
    'zh-CN': '加载配置文件 "{0}" 失败：{1}{2}',
  },
  config_3: {
    en: 'Configuration file "{0}" must default-export a configuration object (consider defineConfig(...)).',
    'zh-CN': '配置文件 "{0}" 必须默认导出配置对象（可使用 defineConfig(...)）。',
  },
  config_4: {
    en: 'Configuration file "{0}" is missing database connection settings.',
    'zh-CN': '配置文件 "{0}" 缺少数据库连接设置。',
  },
  config_5: {
    en: 'Configuration file "{0}" is missing models (at least one model file or directory).',
    'zh-CN': '配置文件 "{0}" 缺少 models（至少指定一个模型文件或目录）。',
  },
  config_6: {
    en: 'Configuration file "{0}" has unsupported language "{1}". Use en or zh-CN.',
    'zh-CN': '配置文件 "{0}" 的语言 "{1}" 不受支持。请使用 en 或 zh-CN。',
  },
  snapshot_1: { en: 'Snapshot is not valid JSON: {0}', 'zh-CN': '快照不是有效的 JSON：{0}' },
  snapshot_2: {
    en: 'Invalid snapshot: missing formatVersion',
    'zh-CN': '快照无效：缺少 formatVersion',
  },
  snapshot_3: {
    en: 'Incompatible snapshot format: file is v{0}, engine supports v{1}',
    'zh-CN': '快照格式不兼容：文件为 v{0}，引擎支持 v{1}',
  },
  snapshot_4: {
    en: 'Invalid snapshot: schema shape mismatch',
    'zh-CN': '快照无效：schema 结构不匹配',
  },
  migrator_1: {
    en: 'Pending migrations must be applied before generating a new migration: {0}. Run tgm deploy first.',
    'zh-CN': '生成新迁移前必须先应用待执行迁移：{0}。请先运行 tgm deploy。',
  },
  migrator_2: {
    en: 'Migration "{0}" was not found in {1}; cannot resolve its state.',
    'zh-CN': '在 {1} 中未找到迁移 "{0}"，无法修正其状态。',
  },
  migrator_3: {
    en: 'Migration "{0}" has no history record and cannot be marked rolled back.',
    'zh-CN': '迁移 "{0}" 没有历史记录，无法标记为已回滚。',
  },
  migrator_4: {
    en: 'Migration "{0}" was applied but its file has changed (checksum mismatch): history {1} / disk {2}. Restore the applied file and create a new migration for corrections.',
    'zh-CN':
      '迁移 "{0}" 已应用，但文件内容被修改（checksum 不一致）：历史 {1} / 文件 {2}。请恢复已应用文件，并创建新迁移进行修正。',
  },
  migrator_5: {
    en: 'Applied migrations are missing from disk: {0}. Restore the files or correct the migration history manually.',
    'zh-CN': '已应用的迁移文件缺失：{0}。请恢复文件或手动修正迁移历史。',
  },
  migrator_6: {
    en: 'Previous migration attempts failed: {0}. The database may be partially changed. Inspect it, then use resolve --applied or resolve --rolled-back.',
    'zh-CN':
      '上一次迁移执行失败：{0}。数据库可能已发生部分变更。请检查数据库，再使用 resolve --applied 或 resolve --rolled-back。',
  },
  migrator_7: {
    en: 'SQL executor did not confirm migration completion',
    'zh-CN': 'SQL 执行器未确认迁移完成',
  },
  migrator_8: { en: 'Migration "{0}" failed: {1}', 'zh-CN': '迁移 "{0}" 执行失败：{1}' },
  runtime_1: {
    en: 'Dialect "{0}" is not implemented (ts-grm driver: {1}). Supported dialects: {2}.',
    'zh-CN': '方言 "{0}" 尚未实现（ts-grm 驱动：{1}）。支持的方言：{2}。',
  },
  runtime_2: {
    en: 'MySQL uses database.database to select a database; schema is not supported',
    'zh-CN': 'MySQL 使用 database.database 选择数据库，不支持 schema 设置',
  },
  runtime_3: {
    en: 'MySQL requires mysql2. Install it with yarn add mysql2',
    'zh-CN': 'MySQL 需要 mysql2。请运行 yarn add mysql2 安装',
  },
  runtime_4: {
    en: 'MySQL 8.0.16+ is required (current: {0}); MariaDB has not been verified',
    'zh-CN': '需要 MySQL 8.0.16 或更高版本（当前版本：{0}）；MariaDB 尚未验证',
  },
  runtime_5: {
    en: 'MySQL connection must specify a database in database.database or connectionString',
    'zh-CN': 'MySQL 连接必须在 database.database 或 connectionString 中指定数据库',
  },
  runtime_6: {
    en: 'MySQL requires lower_case_table_names=0 so model and physical table names match',
    'zh-CN': 'MySQL 要求 lower_case_table_names=0，以确保模型名称与实际表名一致',
  },
  runtime_7: { en: 'Dialect {0} is not implemented', 'zh-CN': '方言 {0} 尚未实现' },
  runtime_8: {
    en: 'Dialect "{0}" does not support schema "{1}". Remove the schema setting.',
    'zh-CN': '方言 "{0}" 不支持 schema "{1}"。请移除 schema 设置。',
  },
  runtime_9: {
    en: 'PostgreSQL requires pg. Install it with yarn add pg (or npm install pg)',
    'zh-CN': 'PostgreSQL 需要 pg。请运行 yarn add pg（或 npm install pg）安装',
  },
  runtime_10: {
    en: 'SQLite requires better-sqlite3. Install it with yarn add better-sqlite3',
    'zh-CN': 'SQLite 需要 better-sqlite3。请运行 yarn add better-sqlite3 安装',
  },
  store_1: {
    en: 'Failed to read migration directory "{0}": {1}',
    'zh-CN': '读取迁移目录 "{0}" 失败：{1}',
  },
  store_2: {
    en: 'Oracle migration history requires a schema',
    'zh-CN': 'Oracle 迁移历史需要指定 schema',
  },
  ddl_1: {
    en: 'SQLite allows at most one AUTOINCREMENT column per table ({0})',
    'zh-CN': 'SQLite 每张表最多允许一个 AUTOINCREMENT 列（{0}）',
  },
  ddl_2: {
    en: 'SQLite requires an INTEGER column for AUTOINCREMENT ({0}.{1} is {2})',
    'zh-CN': 'SQLite 的 AUTOINCREMENT 列必须为 INTEGER 类型（{0}.{1} 的类型为 {2}）',
  },
  ddl_3: {
    en: 'SQLite requires AUTOINCREMENT on the single-column primary key ({0}.{1})',
    'zh-CN': 'SQLite 的 AUTOINCREMENT 列必须是单列主键（{0}.{1}）',
  },
  lock_1: {
    en: 'Another migration process holds {0} (pid {1}, since {2}). If that process no longer exists, remove the lock file and retry.',
    'zh-CN':
      '另一个迁移进程持有锁 {0}（进程号 {1}，获取时间 {2}）。若该进程已不存在，请删除锁文件后重试。',
  },
  lock_2: {
    en: 'Could not acquire migration lock {0} after {1} attempts; other processes may be competing',
    'zh-CN': '尝试 {1} 次后仍无法获取迁移锁 {0}，可能有其他进程正在竞争',
  },
  ddl_mysql_1: {
    en: 'Cannot drop foreign key on {0} without its physical constraint name',
    'zh-CN': '缺少实际约束名称，无法删除表 {0} 上的外键',
  },
  ddl_mysql_2: {
    en: 'Cannot drop constraint on {0} without its physical name',
    'zh-CN': '缺少实际名称，无法删除表 {0} 上的约束',
  },
  ddl_mysql_3: {
    en: 'Altering MySQL column {0}.{1} requires the original column definition in DdlContext',
    'zh-CN': '修改 MySQL 列 {0}.{1} 需要在 DdlContext 中提供原始列定义',
  },
  ddl_mysql_4: {
    en: 'MySQL does not support DEFERRABLE or ON DELETE SET DEFAULT',
    'zh-CN': 'MySQL 不支持 DEFERRABLE 或 ON DELETE SET DEFAULT',
  },
  ddl_mysql_5: {
    en: 'MySQL does not support partial index {0}',
    'zh-CN': 'MySQL 不支持部分索引 {0}',
  },
  ddl_sqlite_1: {
    en: 'Creating table {0} requires a dialect driver in DdlGeneratorOptions.driver',
    'zh-CN': '创建表 {0} 需要在 DdlGeneratorOptions.driver 中提供方言驱动',
  },
  ddl_sqlite_2: {
    en: 'SQLite cannot add an AUTOINCREMENT column ({0}.{1}) to an existing table; AUTOINCREMENT is only allowed in CREATE TABLE as INTEGER PRIMARY KEY.',
    'zh-CN':
      'SQLite 无法向已有表添加 AUTOINCREMENT 列（{0}.{1}）；AUTOINCREMENT 只能在 CREATE TABLE 中用于 INTEGER PRIMARY KEY。',
  },
  ddl_sqlite_3: {
    en: 'SQLite cannot alter the columns or constraints of table "{0}" in place; table rebuild is not implemented. A safe rebuild must preserve external foreign keys, indexes and data. Rebuild manually, then use tgm resolve --applied <id> to record the migration.',
    'zh-CN':
      'SQLite 无法直接修改表 "{0}" 的列或约束，目前尚未实现表重建。安全重建必须保留外部外键、索引和数据。请手动重建，再使用 tgm resolve --applied <id> 记录迁移。',
  },
  ddl_postgres_1: {
    en: 'Changing the identity of existing column {0} requires a manual migration (add or drop GENERATED ... AS IDENTITY by hand, then use tgm resolve --applied <id>).',
    'zh-CN':
      '修改已有列 {0} 的自增策略需要手动迁移（手动添加或删除 GENERATED ... AS IDENTITY，再使用 tgm resolve --applied <id>）。',
  },
  vendor_ts_grm_1: {
    en: 'ts-grm createSchema() did not return structured table definitions (tableDefs is missing). The upstream schema implementation may have changed; check src/vendor/ts-grm.ts.',
    'zh-CN':
      'ts-grm createSchema() 未返回结构化表定义（缺少 tableDefs）。上游的 schema 实现可能已改变，请检查 src/vendor/ts-grm.ts。',
  },
  executor_sqlserver_1: {
    en: 'SQL Server statement failed and rollback could not be confirmed: {0}',
    'zh-CN': 'SQL Server 语句执行失败，无法确认事务是否已回滚：{0}',
  },
  executor_sqlserver_2: {
    en: 'SQL Server statement failed (transaction rolled back): {0}',
    'zh-CN': 'SQL Server 语句执行失败（事务已回滚）：{0}',
  },
  executor_sqlserver_3: {
    en: 'This SQL Server executor already holds a migration lock',
    'zh-CN': '此 SQL Server 执行器已持有迁移锁',
  },
  executor_sqlserver_4: {
    en: 'Could not acquire the SQL Server migration lock',
    'zh-CN': '无法获取 SQL Server 迁移锁',
  },
  executor_mysql_1: {
    en: 'MySQL statement failed: {0}. DDL commits implicitly; earlier statements may have applied. Inspect the database before using resolve.',
    'zh-CN':
      'MySQL 语句执行失败：{0}。DDL 会隐式提交，先前语句可能已经生效。使用 resolve 前请检查数据库。',
  },
  executor_mysql_2: {
    en: 'This MySQL executor already holds a migration lock',
    'zh-CN': '此 MySQL 执行器已持有迁移锁',
  },
  executor_mysql_3: {
    en: 'MySQL connection must specify a database',
    'zh-CN': 'MySQL 连接必须指定数据库',
  },
  executor_mysql_4: {
    en: 'Could not acquire the MySQL migration lock within {0}s',
    'zh-CN': '无法在 {0} 秒内获取 MySQL 迁移锁',
  },
  executor_sqlite_1: {
    en: 'Statement failed (transaction rolled back): {0}',
    'zh-CN': '语句执行失败（事务已回滚）：{0}',
  },
  executor_oracle_1: {
    en: 'Oracle statement failed: {0}. DDL commits implicitly; earlier statements may have applied. Inspect the database before using resolve.',
    'zh-CN':
      'Oracle 语句执行失败：{0}。DDL 会隐式提交，先前语句可能已经生效。使用 resolve 前请检查数据库。',
  },
  executor_oracle_2: {
    en: 'This Oracle executor already holds a migration lock',
    'zh-CN': '此 Oracle 执行器已持有迁移锁',
  },
  executor_oracle_3: {
    en: 'Oracle migration files support SQL only, not PL/SQL or SQL*Plus commands',
    'zh-CN': 'Oracle 迁移文件当前只支持 SQL，不支持 PL/SQL 或 SQL*Plus 命令',
  },
  executor_oracle_4: {
    en: 'Oracle SQL file contains an unterminated string or comment',
    'zh-CN': 'Oracle SQL 文件中的字符串或注释未闭合',
  },
  executor_postgres_1: {
    en: 'Statement failed (transaction rolled back): {0}',
    'zh-CN': '语句执行失败（事务已回滚）：{0}',
  },
  executor_postgres_2: {
    en: 'Could not acquire migration lock within 10s: {0}',
    'zh-CN': '无法在 10 秒内获取迁移锁：{0}',
  },
  introspector_sqlserver_1: {
    en: 'Table {0} is temporal or memory-optimized, which is not supported',
    'zh-CN': '表 {0} 使用时态表或内存优化结构，目前不受支持',
  },
  introspector_sqlserver_2: {
    en: 'Constraint {0} uses a custom clustered layout, which is not supported',
    'zh-CN': '约束 {0} 使用自定义聚集布局，目前不受支持',
  },
  introspector_sqlserver_3: {
    en: 'Foreign key {0} crosses schemas, has an ON UPDATE action, or is disabled/untrusted; migration is not supported',
    'zh-CN': '外键 {0} 跨 schema、包含 ON UPDATE 动作，或处于禁用/不可信状态，无法迁移',
  },
  introspector_sqlserver_4: {
    en: 'CHECK {0} is disabled or untrusted',
    'zh-CN': 'CHECK {0} 已禁用或处于不可信状态',
  },
  introspector_sqlserver_5: {
    en: 'Index {0} uses unsupported clustering, descending order, INCLUDE or disabled attributes',
    'zh-CN': '索引 {0} 使用不受支持的聚集、降序、INCLUDE 或禁用属性',
  },
  introspector_sqlserver_6: {
    en: 'Failed to introspect SQL Server schema: {0}',
    'zh-CN': '读取 SQL Server 数据库结构失败：{0}',
  },
  introspector_sqlserver_7: {
    en: 'Column {0} uses an unsupported generated, sparse, hidden or user-defined type',
    'zh-CN': '列 {0} 使用不受支持的生成列、稀疏列、隐藏列或自定义类型',
  },
  introspector_sqlserver_8: {
    en: 'Column {0} uses rowversion, which is not supported',
    'zh-CN': '列 {0} 使用 rowversion，目前不受支持',
  },
  introspector_mysql_1: {
    en: 'Table {0} uses {1}; only InnoDB is supported',
    'zh-CN': '表 {0} 使用 {1}，目前仅支持 InnoDB',
  },
  introspector_mysql_2: {
    en: 'Failed to introspect MySQL schema: {0}',
    'zh-CN': '读取 MySQL 数据库结构失败：{0}',
  },
  introspector_mysql_3: {
    en: 'Generated or hidden column {0}.{1} is not supported',
    'zh-CN': '不支持生成列或隐藏列 {0}.{1}',
  },
  introspector_mysql_4: {
    en: 'CHECK {0} is not enforced and cannot be migrated',
    'zh-CN': 'CHECK {0} 未强制执行，无法迁移',
  },
  introspector_mysql_5: {
    en: 'Foreign key {0} references another database, which is not supported',
    'zh-CN': '外键 {0} 引用其他数据库，目前不受支持',
  },
  introspector_mysql_6: {
    en: 'Foreign key {0} uses unsupported ON UPDATE {1}',
    'zh-CN': '外键 {0} 使用不受支持的 ON UPDATE {1}',
  },
  introspector_mysql_7: {
    en: 'Unsupported MySQL constraint {0}',
    'zh-CN': '不支持 MySQL 约束 {0}',
  },
  introspector_mysql_8: {
    en: 'Index {0} uses a prefix, expression, descending, hidden or non-BTREE definition; migration is not supported',
    'zh-CN': '索引 {0} 使用前缀、表达式、降序、隐藏或非 BTREE 定义，无法迁移',
  },
  introspector_mysql_9: { en: 'Unsupported ON DELETE {0}', 'zh-CN': '不支持 ON DELETE {0}' },
  introspector_sqlite_1: {
    en: 'Failed to introspect SQLite schema: {0}',
    'zh-CN': '读取 SQLite 数据库结构失败：{0}',
  },
  introspector_oracle_1: {
    en: 'Oracle table {0} uses a temporary, nested or index-organized structure, which is not supported',
    'zh-CN': 'Oracle 表 {0} 使用临时表、嵌套表或索引组织表结构，目前不受支持',
  },
  introspector_oracle_2: {
    en: 'Constraint {0} is disabled, unvalidated or deferred, which is not supported',
    'zh-CN': '约束 {0} 已禁用、未经验证或处于延迟状态，目前不受支持',
  },
  introspector_oracle_3: {
    en: 'Foreign key {0} references another schema, which is not supported',
    'zh-CN': '外键 {0} 引用其他 schema，目前不受支持',
  },
  introspector_oracle_4: {
    en: 'CHECK {0} exceeds the catalog expression length and cannot be read safely',
    'zh-CN': 'CHECK {0} 超出数据库目录的表达式长度限制，无法安全读取',
  },
  introspector_oracle_5: {
    en: 'Unsupported Oracle constraint type {0}',
    'zh-CN': '不支持 Oracle 约束类型 {0}',
  },
  introspector_oracle_6: {
    en: 'Index {0} uses an expression, descending order or a special structure, which is not supported',
    'zh-CN': '索引 {0} 使用表达式、降序或特殊结构，目前不受支持',
  },
  introspector_oracle_7: {
    en: 'Failed to introspect Oracle schema: {0}',
    'zh-CN': '读取 Oracle 数据库结构失败：{0}',
  },
  introspector_oracle_8: {
    en: 'Virtual or hidden column {0} is not supported',
    'zh-CN': '不支持虚拟列或隐藏列 {0}',
  },
  introspector_postgres_1: {
    en: 'Failed to introspect PostgreSQL schema "{0}": {1}',
    'zh-CN': '读取 PostgreSQL schema "{0}" 失败：{1}',
  },
  server_connections_1: {
    en: 'SQL Server requires mssql. Install it with yarn add mssql',
    'zh-CN': 'SQL Server 需要 mssql。请运行 yarn add mssql 安装',
  },
  server_connections_2: {
    en: 'SQL Server 2016+ is required',
    'zh-CN': '需要 SQL Server 2016 或更高版本',
  },
  server_connections_3: {
    en: 'Oracle requires oracledb. Install it with yarn add oracledb',
    'zh-CN': 'Oracle 需要 oracledb。请运行 yarn add oracledb 安装',
  },
  server_connections_4: { en: 'Oracle 19c+ is required', 'zh-CN': '需要 Oracle 19c 或更高版本' },
  server_connections_5: {
    en: 'Could not determine the Oracle schema',
    'zh-CN': '无法确定 Oracle 的 schema',
  },
  server_ddl_1: {
    en: 'Cannot drop constraint on {0} without its physical name',
    'zh-CN': '缺少实际名称，无法删除表 {0} 上的约束',
  },
  server_ddl_2: {
    en: 'Altering {0} column {1}.{2} requires its original definition in DdlContext',
    'zh-CN': '修改 {0} 列 {1}.{2} 需要在 DdlContext 中提供原始定义',
  },
  server_ddl_3: {
    en: 'Changing the identity strategy requires a manual migration',
    'zh-CN': '修改自增策略需要手动迁移',
  },
  server_ddl_4: {
    en: 'Deferrable foreign keys are not supported by this migration dialect',
    'zh-CN': '此迁移方言不支持可延迟的外键',
  },
  server_ddl_5: {
    en: 'Oracle does not support ON DELETE SET DEFAULT',
    'zh-CN': 'Oracle 不支持 ON DELETE SET DEFAULT',
  },
  server_ddl_6: { en: 'Oracle does not support partial indexes', 'zh-CN': 'Oracle 不支持部分索引' },
  server_ddl_7: {
    en: 'Unsupported SQL Server collation name',
    'zh-CN': '不支持此 SQL Server 排序规则名称',
  },
  schema_adapter_1: {
    en: 'Invalid patch metadata for column {0}.{1}: {2}',
    'zh-CN': '列 {0}.{1} 的补丁元数据无效：{2}',
  },
  schema_adapter_2: {
    en: 'Column {0}.{1} declares both autoIncrement() and default(...); a database-generated column cannot carry an explicit default. Remove one of them.',
    'zh-CN':
      '列 {0}.{1} 同时声明了 autoIncrement() 和 default(...)；由数据库生成值的列不能带有显式默认值。请移除其中一项。',
  },
  schema_adapter_3: { en: 'Unsupported constraint type: {0}', 'zh-CN': '不支持此约束类型：{0}' },
  schema_patches_1: {
    en: 'Failed to read column patch metadata {0}: {1}',
    'zh-CN': '读取列补丁元数据 {0} 失败：{1}',
  },
  schema_patches_2: {
    en: 'Invalid column patch metadata {0}: expected boolean',
    'zh-CN': '列补丁元数据 {0} 无效：需要布尔值',
  },
  schema_patches_3: {
    en: 'Unsupported default value for column {0}.{1}: expected a literal (string / number / boolean / bigint) or an upstream dsl.native.* expression. Other ts-grm expressions are not valid column defaults.',
    'zh-CN':
      '列 {0}.{1} 的默认值不受支持：需要字面量（字符串、数值、布尔值或大整数）或上游 dsl.native.* 表达式。其他 ts-grm 表达式不能用作列默认值。',
  },
  schema_patches_4: {
    en: 'Unsupported dsl.native interpolation for column {0}.{1}: only literals, nested dsl.native expressions and interpolated values can be rendered as a column default.',
    'zh-CN':
      '列 {0}.{1} 的 dsl.native 插值不受支持：只有字面量、嵌套的 dsl.native 表达式和插值值可以渲染为列默认值。',
  },
  schema_patches_5: {
    en: 'Unsupported array interpolation for column {0}.{1}: arrays cannot be rendered as a column default.',
    'zh-CN': '列 {0}.{1} 的数组插值不受支持：数组不能渲染为列默认值。',
  },
  schema_patches_6: {
    en: 'Unsupported interpolated value for column {0}.{1}: only literals, Date and expressions can be rendered as a column default.',
    'zh-CN': '列 {0}.{1} 的插值值不受支持：只有字面量、Date 和表达式可以渲染为列默认值。',
  },
} as const;

export type DiagnosticKey = keyof typeof diagnostics;
