# 变更记录

[English](../../CHANGELOG.md) | 简体中文

## 0.1.0-alpha.1 (pending publication)

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
