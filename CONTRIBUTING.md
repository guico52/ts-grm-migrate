# 参与开发

本项目处于 Alpha 阶段。提交 issue 时请给出最小模型、数据库/驱动/Node/core/sql 版本，
并移除连接口令与业务数据。

## 环境与验证

开发工具与 ts-grm 对齐：Yarn 4.1.0、TypeScript 7、tsdown、Biome、Vitest 4。
Node 要求为 `>=24.11.0`，由上游发布产物的 `using` 语法及当前 tsdown 的运行要求共同决定；CI 验证 Node 24.11 和 24。
不照搬上游根 package.json 的 Node ≥18 声明，因为它不满足当前构建工具和 SQLite 驱动要求。

```sh
corepack enable
corepack yarn install --immutable
corepack yarn check
corepack yarn test:package 0.0.9
corepack yarn test:package 0.0.13
corepack yarn test:compat 0.0.9 0.0.13
corepack yarn test:postgres-mysql
corepack yarn test:servers
```

`check` 包含 lint、类型检查、构建、本地测试。本地测试没有数据库环境变量时会跳过服务器测试，
不能将其当作完整数据库验证。两个容器脚本默认使用 Podman，可设置 `CONTAINER_RUNTIME=docker`。
脚本创建临时容器与随机端口，只清理自身资源；请预留镜像空间，不使用业务数据库测试。

`TS_GRM_TEST_VERSION=0.0.9 yarn test:servers` 在隔离目录安装指定历史版本再执行真实数据库测试。
兼容测试不改变仓库的依赖或 lockfile。支持范围和复现方法见 [兼容性](docs/compatibility.md)。

## 修改约定

- 新方言须覆盖模型适配、introspection、DDL、执行器、历史、锁和文档。
- 验证 schema → SQL → introspection → diff 的闭环，并测试数据保留、失败恢复和并发。
- 不支持的数据库结构应明确拒绝，不能静默丢弃。
- ts-grm 内部字段访问集中在 `src/vendor/ts-grm.ts`；改变 peer 范围前验证候选版本。
- 发布包保持 ESM，避免宿主模型注册表被重复加载。不要把 ts-grm 打进 bundle。
- 外部实现参考使用 `@see` 标注来源；引入代码需保留其适用的许可证和作者声明。
- Biome 使用上游的格式偏好；CI 先执行正确性 lint，避免仅为格式批量改写历史代码。

本项目原创贡献使用 MIT；第三方适配声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

`yarn test:coverage` 使用 V8 生成源码覆盖率与 LCOV，不将测试夹具计入覆盖范围。
仅本地测试的覆盖率不代表所有方言覆盖率；当前没有凭单次数字设置全局覆盖率门槛。
