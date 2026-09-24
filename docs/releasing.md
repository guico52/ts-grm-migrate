# 发布

仓库可以先在 GitHub 公开；`package.json` 中的 `private: true` 只阻止误发 npm 包。以下步骤用于首次 npm 发布，开发和试用本地 tarball 的方法见 [README](../README.md#状态与安装)。

1. 确定 GitHub 仓库地址，在 `package.json` 中填写 `repository`、`bugs` 和 `homepage`。检查 Git 历史及打包内容，不带入凭据或本地配置。
2. 确认 GitHub CI 通过，尤其是最低 peer 版本的安装包测试和真实数据库测试。更新 [兼容性说明](compatibility.md)与 `CHANGELOG.md`。
3. 选定 Alpha 版本号，移除 `private: true`；不要扩大未经验证的 peer 范围。
4. 运行 `corepack yarn install --immutable`、`corepack yarn check`、`corepack yarn test:package 0.0.9` 和 `corepack yarn test:package 0.0.13`。
5. 运行 `corepack yarn pack --out /tmp/ts-grm-migrate.tgz`，核对入口、类型声明、许可证和第三方声明都在包内，再由维护者确认 npm 包名、权限和发布版本。

当前 CI 只执行验证，不自动发布 npm 包。
