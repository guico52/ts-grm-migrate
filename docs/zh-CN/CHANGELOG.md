# 变更记录

[English](../../CHANGELOG.md) | 简体中文

## 0.1.0-alpha.1 (pending publication)

- 新增 `dev --create-only` 和只读 `check`，开发生成前验证历史，保留不管理的独立索引，修复 PostgreSQL 依赖排序及 MySQL 自增与默认值联合变更。
- 默认值按方言和列类型比较，不损失数值精度；补丁元数据异常中止；未经证明的 CHECK 差异保留告警。
- 修复隔离环境补丁兼容性验证，补充中英文迁移审核、自定义 SQL、事务恢复和支持范围文档。
- 支持通过可选包 [`ts-grm-patches`](https://www.npmjs.com/package/ts-grm-patches) 声明的列级 `default` 与 `autoIncrement`，为 PostgreSQL / MySQL / SQLite / SQL Server / Oracle 生成对应的 DDL；并归一数据库 catalog 的默认值写法（`::type` cast、外层括号、`N` 前缀、数值加引号），避免重复生成同一条迁移。
- CLI 默认使用简洁英语输出，提供 `--detail` 诊断信息、`--lang zh-CN` 中文提示，以及配置文件中的默认语言设置。
- 调整测试输出，避免默认打印完整快照；保留失败原因和迁移后异常对账信息。
- 移除自动运行的 GitHub Actions workflow，改由维护者执行发布前验证和发包。
- 以英语作为文档第一语言，并提供对应的简体中文文档。

## 0.1.0-alpha.0

- 实现 PostgreSQL、SQLite 基础迁移以及 MySQL、SQL Server、Oracle 方言。
- 增加持久化未完成状态、事务内成功记账、防覆盖迁移文件和稳定数据库锁。
- 添加历史 ts-grm 兼容验证、独立安装包测试及容器数据库测试脚本。
- 对齐 ts-grm 开发工具链，使用 MIT 许可；保留第三方适配声明。

当前尚未发布正式版本。各数据库支持边界见 README；后续发行版在此记录破坏性变更与恢复步骤。
