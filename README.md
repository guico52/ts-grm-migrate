# ts-grm-migrate

[ts-grm](https://github.com/ts-grm) 的数据库 schema 迁移工具 —— 像 Prisma Migrate 那样管理数据库版本，
但**模型就是你写的 ts-grm 代码**，不需要额外的 schema 文件，也没有代码生成步骤。

## 它能做什么

- **增量迁移**：对比你的模型与数据库现状，生成可读的 SQL 迁移文件，并记录应用历史
- **按序部署**：把所有未应用的迁移依次应用到目标库（部署 / CI 场景）
- **快速同步**：直接把数据库改成模型的样子，不写迁移文件、不记历史（开发期图快时用）
- **迁移后对账**：应用完再核对一次数据库与模型，不一致就指出「哪个库、哪张表、差在哪」
- **失败可恢复**：迁移中途失败会记入历史并阻止后续部署，用 `resolve` 修正状态后继续

## 安装

```sh
yarn add -D ts-grm-migrate
```

- `@ts-grm/core` / `@ts-grm/sql` 是 **peerDependencies**，由你的项目提供
- 连 Postgres 还需要 `pg`（也是可选 peer）

装上后可用两个等价的可执行名：`ts-grm-migrate` 与 **`tgm`**。

## 快速开始

> **前置：项目需是 ESM** —— 给 `package.json` 加上 `"type": "module"`。
> ts-grm 的模型注册表是**模块级单例**，migrate 必须与你的模型共用同一份 **ESM** 实例；
> 若模型是 CommonJS，它会把模型注册到另一份实例上，migrate 看不到任何模型。

在项目根建一个配置文件：

```ts
// ts-grm-migrate.config.ts
import { defineConfig } from "ts-grm-migrate";

export default defineConfig({
  database: { host: "localhost", database: "app", user: "postgres" },
  models: ["./src/models"], // 交给 ts-grm 加载你的模型（.ts 或编译后的 .js）
});
```

然后：

```sh
tgm dev -n init          # 对比模型与数据库，生成并应用第一个迁移
tgm dev                  # 不写名字也行：迁移只用时间戳命名
tgm status               # 看看应用了哪些、还剩哪些
```

### 配置项

- **`database`**（必填）：数据库连接，原样传给 `pg` 的 `Pool`
- **`models`**（必填）：模型文件或目录，相对项目根，必须写成 `./xxx` 或 `../xxx`。
  **必须是 ESM** —— 项目声明 `"type": "module"`，或指向编译后的 ESM 产物（`.js`）
- `migrationsDir`：迁移文件目录，默认 `./src/ts-grm`
- `schema`：目标 schema，默认 `public`（非 public 时自动创建）
- `lockPath`：进程锁文件，默认 `./.ts-grm-migrate.lock`

配置文件在项目根自动查找（`.ts` / `.mts` / `.mjs` / `.js`），也可以用 `--config <path>` 指定。
`.ts` 的模块类型跟随项目：CommonJS 项目请用 `.mts`，或给 `package.json` 加 `"type": "module"`。

## 命令

| 命令 | 用途 |
| --- | --- |
| `tgm dev [-n <名字>]` | 对比模型与数据库，生成并应用一个迁移（开发用；名字可省略，省略时只用时间戳命名） |
| `tgm deploy` | 应用所有未应用的迁移（部署 / CI 用，无交互） |
| `tgm push [--force]` | 直接同步成模型的样子，不写文件、不记历史 |
| `tgm status` | 查看已应用 / 待应用的迁移 |
| `tgm resolve --applied <id>` | 把迁移标记为已应用（SQL 已手工执行过） |
| `tgm resolve --rolled-back <id>` | 清除失败记录，让它重新待应用 |

选项：`--config <path>` 指定配置文件、`-n` / `--name <名字>` 给迁移命名、`--force` 破坏性变更不询问、`-h` 显示帮助。

## 行为约定

- **迁移文件是人可读的 SQL**：`<migrationsDir>/<时间戳>_<名字>.sql`，可以手工编辑。
  但**已应用的迁移不能再改** —— 内容一旦变动，后续 `deploy` 会因 checksum 不匹配而拒绝继续
- **破坏性变更会先问**：删表 / 删列 / 改列类型默认交互确认；非交互环境（CI）需显式加 `--force`
- **迁移后自动对账**：`dev` / `deploy` / `push` 完成后会再读一次数据库与模型比对，
  仍有差异就报出具体位置，例如：

  ```
  ⚠ 对账发现数据库与模型不一致（库 app，schema public）：
    - 表 AUTHOR：多出列 LEGACY
  这通常意味着迁移未完整生效，或数据库被手工改动过。
  ```

- **并发防护**：同一项目上的多个 migrate 实例由进程锁文件挡住；多机部署时再由数据库的
  advisory lock 兜底
- **`schema` 是全局生效的**：同时作用于结构读取与 DDL 执行（连接池 `search_path`），
  不会出现「读了 A schema、却往 B schema 写」的情况

## 为什么是 peer 依赖

migrate 是 ts-grm 的插件，必须与你项目里的 ts-grm **共用同一份实例**：ts-grm 的模型注册表是
模块级单例，若 migrate 自带一份 `@ts-grm/core`，它看到的是空注册表，拿不到你定义的任何模型。

因此 `@ts-grm/core` / `@ts-grm/sql` 声明为 peerDependencies，由你的项目提供。

## 更进一步

- [设计与内部分层](docs/design.md) —— 模块划分、设计决策、与 ts-grm 的对接方式、当前进度
- [ts-grm 对接分析](docs/ts-grm-integration.md) —— 早期对 ts-grm 源码的调研快照
