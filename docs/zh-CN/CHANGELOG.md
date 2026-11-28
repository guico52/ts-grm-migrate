# 变更记录

[English](../../CHANGELOG.md) | 简体中文

<!-- @see https://registry.npmjs.org/ts-grm-migrate -->

发布日期按 Asia/Shanghai 时区记录；版本及功能归属已核对 npm registry 和对应发布包。

## 未发布

- 修复 Windows 模型加载：通过 file URL 导入，避免盘符路径被 ESM loader 当成协议。保留延迟加载及共享 ts-grm 注册表，支持 `.mts`/`.mjs`、跳过声明文件，并正确处理路径中的 URL 特殊字符。
- **行为变更**：`allowDropTables` 默认值改为 `false`，省略配置时保留模型中不存在的表；若需继续自动删表，必须显式设为 `true`。严格 drift 检查、其他 DDL、baseline 校验及已有迁移 SQL 的执行行为保持不变。

## 0.1.0-alpha.9（2026-11-28）

- 新增 `allowDropTables`（默认 `true`）；设为 `false` 时跳过自动删表，保留严格 drift 检查、其他 DDL 和已有迁移 SQL 的执行行为。

## 0.1.0-alpha.8（2026-11-28）

- 五种方言支持通过精确表名、glob 和 RegExp 排除表，统一用于迁移及 drift 检查，允许被排除表保留查询模型，并保守拦截跨范围外键变更。
- 新增 `tgm baseline [-n name]` 和 `Migrator.baseline()`：校验受支持的存量表，生成可重放的初始迁移，仅记录已应用，不修改业务数据。
- 补充中英文部分接管、恢复、范围变更及 SQL 重放边界文档，以及 SQLite 端到端与 catalog 回归测试。

## 0.1.0-alpha.7（2026-10-26）

- 恢复 0.1.0-alpha.6 中丢失的 SQLite 结构读取：CHECK 约束、外键未写引用列时补全父表主键列、部分索引谓词、对不支持的表/列/索引结构明确拒绝，以及 NUMERIC 亲和性。使用 SQLite 的 0.1.0-alpha.6 用户应升级。
- 失败日志只有在执行器确认回滚时才声明「事务已回滚」，不再匹配错误文案；SQLite 在 `ROLLBACK` 本身失败时改为报告无法确认回滚。
- 补充文档：程序化调用 `dev()`、`push()` 时若未传 `confirm` 钩子，破坏性变更会直接执行，不做询问。
- `check` 纳入 Biome recommended lint 规则与格式检查；代码注释统一改为中文。

## 0.1.0-alpha.6（2026-10-20）

- 新增显式 `tgm seed`，支持可执行文件与参数配置、`--` 后参数原样透传、本地命令查找、环境变量与终端输入输出继承、退出码传递及中断处理。
- seed 独立于 migration runtime、结构变更和迁移历史；补充中英文示例及子进程 / SQLite 集成测试。
- **已知问题**：本版本意外回退了 0.1.0-alpha.5 对 SQLite 结构读取的加固。SQLite 的 CHECK 约束会在每次 `dev` 时重复生成，引用隐式主键的外键会被误读，不支持的结构也不再被拒绝。已在 0.1.0-alpha.7 修复。

## 0.1.0-alpha.5（2026-10-11）

- 新增 `push --dry-run`。存在待应用、失败、缺失或被修改的迁移文件时拒绝 `push`；同步后仍有差异或用户取消时返回 1。已应用的迁移必须是有序文件的连续前缀。
- 已支持的 CHECK 表达式可经 catalog 格式化后往返一致，其余表达式保守比较。
- SQLite 区分 NUMERIC 与 REAL 亲和性，读取 CHECK 约束与部分索引谓词，先删除引用方表再删除被引用表；拒绝循环删表、生成列/隐藏列、会被改写的特殊索引以及不支持的约束语义。
- 本地锁改用原子创建、可续租的目录租约（`proper-lockfile`），崩溃后 10 秒过期。PostgreSQL 的锁与全部迁移工作在同一会话上执行；SQLite 文件数据库额外按规范化路径加锁。
- 补充在依赖未提升的 workspace 中运行 CLI 的说明（`npx --workspaces=false tgm`）。

## 0.1.0-alpha.4（2026-10-09）

- 补齐 CLI 配置、迁移历史、锁、DDL、事务及差异报告的描述性语言；技术标识保留原样，通过 `--detail` 查看外部错误的原始诊断。
- 按所选语言解释模型命名错误，仅为模块格式错误提供 ESM 排查提示。

## 0.1.0-alpha.3（2026-10-09）

- 新增 `dev --create-only` 和只读 `check`，开发生成前验证历史，保留不管理的独立索引，修复 PostgreSQL 依赖排序及 MySQL 自增与默认值联合变更。
- 默认值按方言和列类型比较，不损失数值精度；补丁元数据异常中止；未经证明的 CHECK 差异保留告警。
- 支持通过可选包 [`ts-grm-patches`](https://www.npmjs.com/package/ts-grm-patches) 声明的列级 `default` 与 `autoIncrement`，为 PostgreSQL / MySQL / SQLite / SQL Server / Oracle 生成对应的 DDL；并归一数据库 catalog 的默认值写法（`::type` cast、外层括号、`N` 前缀、数值加引号），避免重复生成同一条迁移。
- 修复隔离环境补丁兼容性验证，补充中英文迁移审核、自定义 SQL、事务恢复和支持范围文档。

## 0.1.0-alpha.2

已从 npm 撤下，无法安装。

## 0.1.0-alpha.1（2026-09-26）

- CLI 默认使用简洁英语输出，提供 `--detail` 诊断信息、`--lang zh-CN` 中文提示，以及配置文件中的默认语言设置。
- 调整测试输出，避免默认打印完整快照；保留失败原因和迁移后异常对账信息。
- 移除自动运行的 GitHub Actions workflow，改由维护者执行发布前验证和发包。
- 以英语作为文档第一语言，并提供对应的简体中文文档。

## 0.1.0-alpha.0（2026-09-24）

- 实现 PostgreSQL、SQLite 基础迁移以及 MySQL、SQL Server、Oracle 方言。
- 增加持久化未完成状态、事务内成功记账、防覆盖迁移文件和稳定数据库锁。
- 添加历史 ts-grm 兼容验证、独立安装包测试及容器数据库测试脚本。
- 对齐 ts-grm 开发工具链，使用 MIT 许可；保留第三方适配声明。

当前尚未发布正式版本。各数据库支持边界见 README；后续发行版在此记录破坏性变更与恢复步骤。
