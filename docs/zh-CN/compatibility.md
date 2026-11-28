# 兼容性

[English](../compatibility.md) | 简体中文

安装要求和数据库支持表见 [README](README.md)。这里解释 `@ts-grm/core` / `@ts-grm/sql` peer 范围的依据，以及如何重新验证它。

两个 ts-grm 包必须同版。当前支持 `>=0.0.9 <0.0.14`；`0.0.9` 是完整模型类型检查和本地测试通过的最低版本。`0.0.1`–`0.0.8` 缺少测试模型所需的 API，不列入支持范围。不要仅凭本地 checkout 的版本号扩大范围：验证应安装 npm 上的发布产物。

`0.0.9` 和 `0.0.13` 已进行独立安装包测试，并在 PostgreSQL 17、MySQL 8.4、SQL Server 2022、Oracle Free 23 上验证。中间版本通过类型检查和本地测试，但没有逐一跑完所有真实数据库组合。每次扩大 peer 范围，都应重新验证最低和最高目标版本。

```sh
corepack yarn install --immutable
corepack yarn test:compat 0.0.9 0.0.13
corepack yarn test:package 0.0.9
corepack yarn test:package 0.0.13
TS_GRM_TEST_VERSION=0.0.9 corepack yarn test:postgres-mysql
TS_GRM_TEST_VERSION=0.0.9 corepack yarn test:servers
```

`test:compat` 在临时目录安装指定版本，并运行包含完整模型的类型检查和本地测试；报告写入临时 JSON 文件，也可以用 `COMPAT_REPORT` 指定路径。数据库脚本需要 Podman，或用 `CONTAINER_RUNTIME=docker` 切换到 Docker。发布前手动检查最低与当前 peer 版本。

Node 最低版本为 `24.11.0`。`@ts-grm/sql@0.0.13` 的发布产物包含 `using` 声明；已检查的 Node 22.18.0、22.22.3 和 22.23.2 均无法解析该语法。本项目没有改写上游产物，因此不声明 Node 22 支持。以后如上游构建产物或 Node 运行时变化，应在干净环境中重新测试后再调整 `engines`。

迁移器读取 ts-grm 返回对象中的内部 `tableDefs`。这不是上游公开类型承诺的一部分；版本变化时应先检查 `src/vendor/ts-grm.ts`，再运行上述矩阵。

## 模型加载兼容性

下一未发布版本由 tgm 通过 `pathToFileURL` 导入模型文件，再让共享的 ts-grm `EntityManager` 读取已注册模型，不重复扫描模型路径。这样绕开上游在 Windows 上直接导入绝对路径的问题，并保留模块未导出模型时的注册副作用。该适配集中在 `src/vendor/ts-grm.ts` 的 `registeredEntityManager`；调整 peer 范围时需重新验证。

已在 Linux 上通过 ts-grm `0.0.9` 和 `0.0.13` 的干净安装包及原生模型加载验证。`tests/model-loader.test.ts` 覆盖 Windows 盘符/UNC URL 转换、含空格/中文/URL 特殊字符路径的原生导入、`.mts`/`.mjs`、声明文件跳过及重复遍历。这不等于 Windows 主机端到端验证；如需声明该覆盖，应在 Windows 上使用目标 Node 和数据库驱动版本运行 `corepack yarn check` 及干净安装包测试。

## 可选列补丁

`ts-grm-patches@0.1.0` 仅支持 ts-grm `>=0.0.13 <0.0.14`，不缩小迁移器的基础 peer 范围。兼容性脚本在 `0.0.13` 的隔离环境中安装补丁，共享该环境的 ORM 实例；较早版本仅运行基础测试，不包含补丁专属模型。JSON 报告注明是否验证补丁。`0.0.13` 的干净安装包测试同时验证补丁安装、`--create-only`、部署与 `check`。
