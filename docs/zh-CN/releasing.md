# 发布

[English](../releasing.md) | 简体中文

`ts-grm-migrate` 已发布到 npm，当前采用 Alpha 版本。发布由维护者手动执行，仓库不配置自动运行或自动发布的 GitHub Actions workflow。

每次发布前：

1. 更新 `package.json` 版本和 `CHANGELOG.md`；一个版本号不能重复发布。扩大 peer 范围前按[兼容性说明](compatibility.md)重新验证。
2. 在 Node 24.11 和当前 24 上运行 `corepack yarn install --immutable`、`corepack yarn check`、`corepack yarn test:package 0.0.9`、`corepack yarn test:package 0.0.13`。涉及数据库迁移行为时，还要运行 `corepack yarn test:postgres-mysql` 和 `corepack yarn test:servers`。
3. 运行 `npm publish --dry-run --tag next`，核对入口、类型声明、许可证、第三方声明和 README。确认工作区状态及要发布的版本。
4. 由维护者登录 npm，运行 `npm publish --tag next`，再查询 npm registry 确认版本与 dist-tag。

确认 `package.json` 中的 `repository`、`bugs` 和 `homepage` 指向当前维护的仓库。发布前检查 Git 历史和打包清单，不携带凭据或本地配置。

列补丁修改需同时通过 `0.0.13` 的补丁测试与 `0.0.9` 的基础兼容性测试。确认 `--create-only` 不写历史、`check` 不写数据库、独立索引在模型演进后保留。修改生成 SQL 时，发布前在隔离的空数据库中应用完整迁移历史。
