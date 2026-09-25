# ts-grm-migrate

[ts-grm](https://github.com/babyfish-ct/ts-grm) 的数据库 schema 迁移工具 —— 像 Prisma Migrate 那样管理数据库版本，
但**模型就是你写的 ts-grm 代码**，不需要额外的 schema 文件，也没有代码生成步骤。

## 功能清单

- **增量迁移**：对比你的模型与数据库现状，生成可读的 SQL 迁移文件，并记录应用历史
- **按序部署**：把所有未应用的迁移依次应用到目标库（部署 / CI 场景）
- **快速同步**：快速执行迁移SQL，将数据库同步为model定义的形状
- **迁移后对账**：应用完再核对数据库与模型，不一致就指出「哪个库、哪张表、差在哪」
- **失败可恢复**：迁移中途失败会记入历史并阻止后续部署，用 `resolve` 修正状态后继续

## 状态与安装

**Alpha，已发布到 [npm](https://www.npmjs.com/package/ts-grm-migrate)。** 首版为 `0.1.0-alpha.0`；
仅承诺下表列出的验证范围，不保证任意数据库结构或历史版本兼容。
运行环境与当前 ts-grm 工具链一致：Node `>=24.11.0`、ESM。
开发使用 Yarn 4.1.0、TypeScript 7、tsdown、Biome 与 Vitest 4。

在使用者项目中安装。以下命令对应下方的 PostgreSQL 快速开始示例：

```sh
npm install @ts-grm/core@0.0.13 @ts-grm/sql@0.0.13 pg
npm install -D ts-grm-migrate@next
```

- core/sql 是 peerDependencies，请使用**相同版本**；当前支持 `>=0.0.9 <0.0.14`。
  这是已验证范围，不自动承诺未来版本；验证方法见 [兼容性](docs/compatibility.md)。
- 数据库驱动按需安装，完整列表见下方支持表。
- `@next` 跟随预发布版本；需要固定版本时请写明版本号，例如 `ts-grm-migrate@0.1.0-alpha.0`。
- 安装后使用 `npx tgm`，或通过包管理器运行 `tgm` / `ts-grm-migrate`。

## 快速开始

> **前置：项目需是 ESM** —— 给 `package.json` 加上 `"type": "module"`。
> ts-grm 的模型注册表是**模块级单例**，migrate 必须与你的模型共用同一份 **ESM** 实例；
> 若模型是 CommonJS，它会把模型注册到另一份实例上，migrate 看不到任何模型。

在项目根建一个配置文件：

```ts
// ts-grm-migrate.config.ts
import { defineConfig } from "ts-grm-migrate";

export default defineConfig({
  dialect: "postgres",
  database: { host: "localhost", database: "app", user: "postgres" },
  models: ["./src/models"], // 交给 ts-grm 加载你的模型（.ts 或编译后的 .js）
});
```

然后：

```sh
npx tgm dev -n init      # 对比模型与数据库，生成并应用第一个迁移
npx tgm dev              # 不写名字也行：迁移只用时间戳命名
npx tgm status           # 看看应用了哪些、还剩哪些
```

### 配置项

- **`dialect`**：数据库方言，可选 `postgres`、`sqlite`、`mysql`、`mssql`、`oracle`，默认 `postgres`。
  它决定使用哪个数据库驱动，以及结构读取、SQL 生成和迁移执行的具体实现；各方言的驱动依赖与支持范围见下表。
- **`database`**（必填）：数据库连接，字段含义随方言变化，见下文示例
- **`models`**（必填）：模型文件或目录，相对项目根，必须写成 `./xxx` 或 `../xxx`。
  **必须是 ESM** —— 项目声明 `"type": "module"`，或指向编译后的 ESM 产物（`.js`）
- `migrationsDir`：迁移文件目录，默认 `./src/ts-grm`
- `schema`：目标 schema，PostgreSQL 默认 `public`，SQL Server 默认 `dbo`，Oracle 默认登录用户
- `lockPath`：进程锁文件，默认 `./.ts-grm-migrate.lock`

配置文件在项目根自动查找（`.ts` / `.mts` / `.mjs` / `.js`），也可以用 `--config <path>` 指定。
`.ts` 的模块类型跟随项目：CommonJS 项目请用 `.mts`，或给 `package.json` 加 `"type": "module"`。

## 数据库支持与配置

| `dialect` | 驱动依赖 | 支持范围 |
| --- | --- | --- |
| `postgres`（默认） | `pg` | PostgreSQL，schema 默认 `public` |
| `sqlite` | `better-sqlite3` | 基础迁移；需要重建表的变更尚未实现 |
| `mysql` | `mysql2` | MySQL 8.0.16+ / InnoDB，`lower_case_table_names=0` |
| `mssql` | `mssql` | SQL Server 2016+，schema 默认 `dbo`；已验证 SQL Server 2022 |
| `oracle` | `oracledb` | Oracle 19c+，schema 默认登录用户；已验证 Oracle Free 23 |

SQL Server 示例：

```ts
export default defineConfig({
  dialect: "mssql",
  database: {
    host: "localhost", port: 1433, database: "app", user: "app", password: process.env.DB_PASSWORD,
    // 本地自签名测试证书可启用；生产环境默认校验证书。
    trustServerCertificate: true,
  },
  schema: "dbo",
  models: ["./src/models"],
});
```

Oracle 示例（Thin mode，无需安装 Oracle Client）：

```ts
export default defineConfig({
  dialect: "oracle",
  database: {
    user: "APP", password: process.env.DB_PASSWORD,
    connectionString: "localhost:1521/FREEPDB1",
  },
  models: ["./src/models"],
});
```

Oracle `database.database` 表示 service name，也可用 `host` / `port` / `database` 代替
`connectionString`。Oracle schema 必须已存在；SQL Server 会创建尚不存在的目标 schema。
SQL Server 和 Oracle 的自动生成 DDL 与历史表均限定目标 schema，避免读写落在不同命名空间。

Oracle 用户需要 `CREATE SESSION`、`CREATE TABLE`、表空间配额；创建 identity 列还需要
`CREATE SEQUENCE`。数据库锁使用 `DBMS_LOCK`，需由 DBA 授权：

```sql
GRANT EXECUTE ON SYS.DBMS_LOCK TO APP;
```

MySQL / Oracle 的 DDL 会隐式提交，失败可能留下部分改动。`resolve --rolled-back` 仅修改历史状态，
**不会撤销 SQL**；应先手工恢复数据库再重试，或补完 SQL 后 `resolve --applied`。
PostgreSQL、SQLite、SQL Server 在同一事务内执行迁移 SQL 并记录成功，记账失败也会回滚。
所有方言都会在执行前持久化未完成记录；进程中断、连接丢失或记账失败后会阻止自动重放，
需检查数据库实际状态，再使用 `resolve`。未完成记录在 `status` 中显示为 failed。
`status` 仅将确认不存在的历史表视为空历史，连接和权限错误会向上传递；Oracle 跨 schema
的 ORA-00942 无法区分缺表与无权限，因此保留错误。

新迁移 ID 使用毫秒时间戳，并在本地锁内保证晚于已有生成时间戳；文件使用独占创建，
遇到已有同名文件会报错，不覆盖历史 SQL。PostgreSQL 数据库锁按数据库和当前 schema
限定固定资源名，不依赖 checkout 的本地路径。

当前边界：

- SQL Server / Oracle 支持普通表、列、主键、唯一约束、外键、CHECK 和普通索引；
  修改 identity 策略、自动重命名及复杂表重建不支持。
- SQL Server 的计算/隐藏/稀疏列、temporal/memory-optimized 表、自定义聚集约束布局、
  降序/INCLUDE/特殊索引会明确拒绝。
- Oracle 的虚拟/隐藏列、IOT/嵌套/临时表、特殊/表达式/降序索引、延迟约束会明确拒绝。
- 两者目前不支持跨 schema 外键及未启用/未验证的约束。CHECK 只做保守的格式归一化，
  不承诺任意两种等价表达式都能匹配。
- Oracle 迁移文件支持以分号分隔的 SQL，正确保留字符串、标识符、注释中的分号；
  PL/SQL、SQL*Plus 指令暂不支持，会在执行文件前拒绝。SQL Server 文件使用 SQL 批次，
  不支持客户端的 `GO` 分隔符。
- MySQL 暂不支持 MariaDB、生成列、隐藏列及特殊索引。

### 容器集成测试

```sh
corepack yarn install
corepack yarn test:servers
```

脚本默认用 Podman 启动 SQL Server Developer 与 Oracle Free（`CONTAINER_RUNTIME=docker` 可切换 Docker），随机分配仅监听 `127.0.0.1` 的端口，
在独立 schema/用户中验证迁移、数据保留、锁、失败恢复与 CLI，完成后清理本次容器和数据卷。
MySQL 集成测试始终创建随机专属数据库并清理，不使用 `MYSQL_DATABASE`；测试账号需要建库权限。
可通过 `MSSQL_TEST_IMAGE` / `ORACLE_TEST_IMAGE` 指定镜像。首次拉取镜像需要网络及足够磁盘空间。
SQL Server Developer 的测试用途受其许可条款约束，脚本用 `ACCEPT_EULA=Y` 启动。

也可对专用测试实例设置 `MSSQL_HOST/PORT/USER/PASSWORD/DATABASE` 或
`ORACLE_HOST/PORT/PASSWORD/DATABASE`，运行 `tests/server-integration.test.ts`。
Oracle 测试使用 SYSTEM 创建临时用户，需要该账户拥有 `DBMS_LOCK` 的转授权权限；
这些权限仅供测试环境使用。未设置对应 `*_HOST` 时，集成测试会跳过。

## 命令

| 命令 | 用途 |
| --- | --- |
| `tgm dev [-n <名字>]` | 对比模型与数据库，生成并应用一个迁移（开发用；名字可省略，省略时只用时间戳命名） |
| `tgm deploy` | 应用所有未应用的迁移（部署 / CI 用，无交互） |
| `tgm push [--force]` | 直接同步成模型的样子，不写文件、不记历史 |
| `tgm status` | 查看已应用 / 待应用的迁移 |
| `tgm resolve --applied <id>` | 把迁移标记为已应用（SQL 已手工执行过） |
| `tgm resolve --rolled-back <id>` | 清除失败记录，让它重新待应用 |

选项：`--config <path>` 指定配置文件、`-n` / `--name <名字>` 给迁移命名、`--force` 破坏性变更不询问、`--detail` 显示执行步骤、SQL 和锁信息、`--lang <en|zh-CN>` 指定 CLI 语言（默认英语）、`-h` 显示帮助。

普通执行只输出目标库、迁移数量或 ID 和最终结果；`status` 是主动查询，仍会列出迁移。
例如 `tgm deploy` 完成时会显示 `Applied 2 migrations to postgres/app/public.`；
`tgm deploy --detail --lang zh-CN` 会显示中文提示及逐项执行细节。
详细模式中的 SQL 可能包含业务数据值，请谨慎保存或分享终端日志；密码等连接凭据不会由诊断事件输出。
`zh-CN` 翻译帮助、进度、结果和交互提示；底层诊断与数据库驱动返回的原始错误保留英文或原文，便于检索和排查。

## 行为约定

- **迁移文件是人可读的 SQL**：`<migrationsDir>/<时间戳>_<名字>.sql`，可以手工编辑。
  但**已应用的迁移不能再改** —— 内容一旦变动，后续 `deploy` 会因 checksum 不匹配而拒绝继续
- **破坏性变更会先问**：删表 / 删列 / 改列类型默认交互确认；非交互环境（CI）需显式加 `--force`
- **迁移后自动对账**：`dev` / `deploy` / `push` 完成后会再读一次数据库与模型比对，
  仍有差异就报出具体位置，例如：

  ```
  Warning: postgres/app/public differs from the model:
    - Table AUTHOR: Extra column LEGACY
  Check for a partial migration or manual database changes.
  ```

- **并发防护**：同一项目上的多个 migrate 实例由进程锁文件挡住；多机部署时再由数据库的
  advisory lock 兜底
- **`schema` 是全局生效的**：同时作用于结构读取与 DDL 执行（PostgreSQL `search_path`，SQL Server / Oracle 限定表名），
  避免出现schema读取和写入不一致的情况


## 许可证

原创代码采用 [MIT](LICENSE)。ts-grm 使用 Apache-2.0；本项目改写的上游结构类型保留其许可与署名，
见[第三方声明](THIRD_PARTY_NOTICES.md)。
