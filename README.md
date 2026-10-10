# ts-grm-migrate

English | [简体中文](docs/zh-CN/README.md)

Database schema migrations for [ts-grm](https://github.com/babyfish-ct/ts-grm). Manage database versions with SQL migration files while keeping your ts-grm models as the source of truth. No separate schema file or code generation is required.

The current scope is **new ts-grm applications and subsequent model evolution**. Start with an empty database. Adopting existing application databases and baselining pre-existing tables are not supported. A shadow database is deliberately omitted; see [migration workflows and design tradeoffs](docs/migrations.md).

## Features

- **Incremental migrations:** compare models with the database, generate readable SQL files, and record applied history.
- **SQL review:** `dev --create-only` generates a pending file for review and editing before deployment.
- **Strict checks:** `check` reports model/database drift with a nonzero exit code.
- **Ordered deployment:** apply pending migration files in order, including in deployment pipelines.
- **Direct synchronization:** bring a database in line with the models without writing migration history.
- **Post-migration checks:** report schema differences that remain after applying changes.
- **Failure recovery:** record failed or interrupted attempts and require an explicit `resolve` before retrying.
- **Column defaults and auto-increment:** with the optional [`ts-grm-patches`](https://www.npmjs.com/package/ts-grm-patches) package installed, models can declare `default(...)` and `autoIncrement()` and migrations create the matching database features.

## Status and installation

**Alpha, published on [npm](https://www.npmjs.com/package/ts-grm-migrate).** The first release was `0.1.0-alpha.0`. Support is limited to the verified combinations and features below; arbitrary existing schemas and historical versions are not guaranteed to work.

Runtime requirements are Node `>=24.11.0` and ESM. Development uses Yarn 4.1.0, TypeScript 7, tsdown, Biome, and Vitest 4.

Install the migration CLI in your application. These commands match the PostgreSQL example below:

```sh
npm install @ts-grm/core@0.0.13 @ts-grm/sql@0.0.13 pg
npm install -D ts-grm-migrate@next
```

- `@ts-grm/core` and `@ts-grm/sql` are peer dependencies and must use the **same version**. The verified range is `>=0.0.9 <0.0.14`; see [compatibility](docs/compatibility.md) before changing it.
- Install only the database driver you need; the supported drivers are listed below.
- `@next` follows prereleases. Pin an exact version when reproducibility matters, for example `ts-grm-migrate@0.1.0-alpha.0`.
- Run the installed CLI with `npx tgm`, or use `tgm` / `ts-grm-migrate` through your package manager.

In a workspace with non-hoisted dependencies (for example a Bun installation), npm's workspace lookup may miss the child's local CLI or select a different version installed at the root. From the child project, use:

```bash
npx --workspaces=false tgm dev --create-only -n init
```

This keeps npm's lookup in the current project. If npm reports `No versions available for tgm`, it has failed to locate the local executable and is looking for a package named `tgm`; the package to install is `ts-grm-migrate`. Check that `node_modules/.bin/tgm` resolves to an existing `dist/bin.mjs`, and reinstall dependencies with the project's package manager if the link is broken. The CLI cannot repair npm's command resolution because it has not started yet. [npm exec workspace behavior](https://docs.npmjs.com/cli/npm-exec/).

## Quick start

> **Your project must use ESM.** Set `"type": "module"` in `package.json`. The ts-grm model registry is a module-level singleton; the migration tool and your models must share the same ESM instance. CommonJS models may register with a separate instance and be invisible to the migration tool.

Create a configuration file in your project root:

```ts
// ts-grm-migrate.config.ts
import { defineConfig } from "ts-grm-migrate";

export default defineConfig({
  dialect: "postgres",
  database: { host: "localhost", database: "app", user: "postgres" },
  models: ["./src/models"], // ts-grm loads these .ts files or compiled .js files
  // language: "zh-CN",    // Optional: use Chinese for this project's CLI output
});
```

Then run:

```sh
npx tgm dev --create-only -n init  # Generate SQL for review
# Review the generated SQL file, then:
npx tgm deploy                    # Apply the first migration
npx tgm check                     # Check that the model matches
npx tgm dev              # Omit the name to use only a timestamp
npx tgm status           # Inspect applied and pending migrations
```

### Configuration

- **`dialect`:** `postgres`, `sqlite`, `mysql`, `mssql`, or `oracle`; defaults to `postgres`. It selects the driver, schema introspection, SQL generation, and execution. See the support table below.
- **`database` (required):** connection settings; fields depend on the dialect.
- **`models` (required):** model files or directories relative to the project root, starting with `./` or `../`. They must be ESM: declare `"type": "module"` or point to compiled ESM `.js` files.
- `language`: project default for CLI output, `en` or `zh-CN`; defaults to `en`. `--lang` overrides it for one command.
- `migrationsDir`: migration file directory; defaults to `./src/ts-grm`.
- `schema`: target schema; defaults to `public` on PostgreSQL, `dbo` on SQL Server, and the login user's schema on Oracle.
- `lockPath`: process lock file; defaults to `./.ts-grm-migrate.lock`.

The CLI searches the project root for a `.ts`, `.mts`, `.mjs`, or `.js` configuration file. Use `--config <path>` to choose one explicitly. A `.ts` file follows the project's module type; in a CommonJS project, use `.mts` or set `"type": "module"`.

## Defaults and auto-increment (optional)

Upstream ts-grm column metadata expresses neither column defaults nor auto-increment, so a model cannot declare `serial` / `identity` / `auto_increment` or a `DEFAULT` value on its own. As of this release that capability comes from a companion package, [ts-grm-patches](https://www.npmjs.com/package/ts-grm-patches); install it alongside the CLI:

```sh
npm install -D ts-grm-patches@0.1.0
```

`ts-grm-patches@0.1.0` requires both ts-grm peers at `0.0.13`. The broader `0.0.9`–`0.0.13` range applies to the migrator without the companion package.

Then install the patch once, **before any `model(...)` definition**:

```ts
// ts-grm-migrate.config.ts (or any module your models import first)
import { applyPatches } from "ts-grm-patches";

applyPatches();
```

```ts
const User = model(
  "User",
  "id",
  class {
    id = prop.i32().autoIncrement();          // serial / identity / auto_increment
    status = prop.str(20).default("active");  // literal
    createdAt = prop.dt().default(dsl.native.date`now()`); // SQL expression
  },
);
```

No migrate-side configuration is needed: the model adapter detects the patch and manages both attributes. `ts-grm-patches` only declares them and carries the metadata; turning them into DDL is this tool's job.

What changes once the patch is installed:

- **The model becomes authoritative for these two attributes.** A column without `default(...)` is diffed as "no default", so a default that exists only in the database is dropped (`alter column ... drop default`). Without the patch, migrate leaves existing defaults and auto-increment untouched.
- `autoIncrement()` and `default(...)` are mutually exclusive on one column; declaring both is rejected.
- **On PostgreSQL, SQL Server, Oracle, and SQLite, switching auto-increment on or off for an existing column requires a manual SQL migration** (see [workflow](docs/migrations.md#custom-sql-and-unsupported-automatic-changes)): PostgreSQL, SQL Server, and Oracle cannot do it in place safely, and SQLite cannot alter tables at all. MySQL supports switching existing columns and updates their defaults together. Creating a table with `autoIncrement()` is supported on all dialects; adding such a column is supported except on SQLite.
- Expression defaults accept `dsl.native.*` expressions (for example `` dsl.native.str`uuid_generate_v4()` ``); other ts-grm expression nodes are rejected rather than rendered as questionable SQL. Literals accept the column's value type.
- If `applyPatches()` runs after a model was defined, that model's columns are not affected.

Per-dialect rendering:

- **PostgreSQL:** `generated by default as identity` for `autoIncrement()`.
- **MySQL:** `auto_increment`.
- **SQLite:** `INTEGER PRIMARY KEY AUTOINCREMENT` (the column must be the single-column, integer primary key; adding one to an existing table is rejected) and `default (expr)` for expressions.
- **SQL Server / Oracle:** `identity(1,1)` / `generated by default as identity`.

Catalog forms differ from what the model writes: PostgreSQL adds type casts (`'active'::character varying`), SQL Server wraps expressions in parentheses and prefixes unicode literals with `N`, and MySQL quotes numeric defaults. The differ normalizes whole-literal casts compatible with the target type, catalog parentheses, and dialect-specific prefixes. Textual digits remain text, numbers are compared without floating-point precision loss, and casts inside expressions are preserved. Unproven expression equivalence may still appear as a difference. Metadata getter failures abort migration rather than requesting deletion.

## Databases and configuration

| `dialect` | Driver dependency | Supported scope |
| --- | --- | --- |
| `postgres` (default) | `pg` | PostgreSQL; default schema `public` |
| `sqlite` | `better-sqlite3` | Basic migrations; table rebuilds are not implemented |
| `mysql` | `mysql2` | MySQL 8.0.16+, InnoDB, `lower_case_table_names=0` |
| `mssql` | `mssql` | SQL Server 2016+; default schema `dbo`; tested on SQL Server 2022 |
| `oracle` | `oracledb` | Oracle 19c+; default schema is the login user; tested on Oracle Free 23 |

SQL Server example:

```ts
export default defineConfig({
  dialect: "mssql",
  database: {
    host: "localhost", port: 1433, database: "app", user: "app", password: process.env.DB_PASSWORD,
    // Use only for local tests with self-signed certificates; production validates certificates by default.
    trustServerCertificate: true,
  },
  schema: "dbo",
  models: ["./src/models"],
});
```

Oracle example (Thin mode; no Oracle Client installation needed):

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

For Oracle, `database.database` is the service name. You can provide `host`, `port`, and `database` instead of `connectionString`. The Oracle schema must already exist; SQL Server creates a missing target schema. Generated DDL and migration history on both dialects are scoped to that schema.

The Oracle user needs `CREATE SESSION`, `CREATE TABLE`, and a tablespace quota. Identity columns also require `CREATE SEQUENCE`. A DBA must grant access to `DBMS_LOCK` for database locking:

```sql
GRANT EXECUTE ON SYS.DBMS_LOCK TO APP;
```

MySQL and Oracle DDL commits implicitly and may leave partial changes after failure. `resolve --rolled-back` changes **history only**; it does not undo SQL. Restore the database manually before retrying, or complete the SQL and use `resolve --applied`.

PostgreSQL, SQLite, and SQL Server execute migration SQL and record success in one transaction, so a failure to record success rolls back the SQL. Every dialect persists an unfinished attempt before execution. A crash, lost connection, or history-write failure blocks automatic replay until you inspect the database and use `resolve`. `status` shows unfinished attempts as failed. It treats only a confirmed missing history table as empty history; connection and permission errors propagate. Oracle's ORA-00942 cannot reliably distinguish a missing table from lack of access across schemas, so that error is preserved.

New migration IDs use millisecond timestamps and advance past existing IDs while holding the local lock. Files are created exclusively; an existing filename causes an error instead of overwriting historical SQL. PostgreSQL uses a fixed database lock resource scoped to the database and current schema, independent of the checkout path.

Current limits:

- SQL Server and Oracle support ordinary tables, columns, primary keys, unique constraints, foreign keys, CHECK constraints, and ordinary indexes. Identity strategy changes, automatic renames, and complex table rebuilds are unsupported.
- SQL Server explicitly rejects computed, hidden, and sparse columns; temporal and memory-optimized tables; custom clustered constraint layouts; and descending, INCLUDE, or special indexes.
- Oracle explicitly rejects virtual and hidden columns; index-organized, nested, and temporary tables; special, expression, and descending indexes; and deferred constraints.
- Both reject cross-schema foreign keys and disabled or unvalidated constraints. CHECK expressions receive conservative normalization; equivalent expressions are not guaranteed to compare as equal.
- Oracle migration files may contain semicolon-separated SQL, including semicolons inside strings, identifiers, and comments. PL/SQL and SQL*Plus directives are rejected before execution. SQL Server files use SQL batches; the client-side `GO` separator is unsupported.
- MySQL support does not include MariaDB, generated or hidden columns, or special indexes.

### Container integration tests

```sh
corepack yarn install
corepack yarn test:servers
```

By default, the script starts SQL Server Developer and Oracle Free with Podman (`CONTAINER_RUNTIME=docker` selects Docker). It binds random ports to `127.0.0.1`, tests migrations, data preservation, locks, recovery, and the CLI in isolated schemas or users, then removes its containers and volumes. MySQL integration tests create and remove their own randomly named database rather than using `MYSQL_DATABASE`; the test account needs database-creation permission.

Set `MSSQL_TEST_IMAGE` or `ORACLE_TEST_IMAGE` to select images. The first run needs network access and enough disk space. SQL Server Developer testing is subject to its license terms; the script starts it with `ACCEPT_EULA=Y`.

You can also run `tests/server-integration.test.ts` against dedicated instances by setting `MSSQL_HOST/PORT/USER/PASSWORD/DATABASE` or `ORACLE_HOST/PORT/PASSWORD/DATABASE`. Oracle tests use SYSTEM to create temporary users, so SYSTEM needs permission to grant `DBMS_LOCK` to them. Those privileges are for test environments only. Integration tests skip when the corresponding `*_HOST` is unset.

## Commands

| Command | Purpose |
| --- | --- |
| `tgm dev [-n <name>]` | Compare models with the database, then generate and apply a migration (the name is optional) |
| `tgm dev --create-only [-n <name>]` | Generate a pending SQL file for review without applying it |
| `tgm check` | Read-only model/database comparison; exit 1 for drift or an error |
| `tgm deploy` | Apply pending migrations in order without interaction |
| `tgm push [--force]` | Sync the database to the models without a file or history record |
| `tgm status` | Show applied and pending migrations |
| `tgm resolve --applied <id>` | Mark SQL already executed manually as applied |
| `tgm resolve --rolled-back <id>` | Mark an attempt as rolled back so it becomes pending again |

Options: `--dry-run` previews SQL without applying it (`push` only); `--create-only` generates without applying (`dev` only); `--config <path>` selects a configuration file; `-n` / `--name <name>` names a migration; `--force` skips destructive-change confirmation; `--detail` shows execution steps, SQL, and locks; `--lang <en|zh-CN>` selects the language for this command; `-h` shows help.

Normal commands report the target, migration count or ID, and result. `status` intentionally lists migrations because it is an inspection command. For example, `tgm deploy` may print `Applied 2 migrations to postgres/app/public.` The SQL shown with `--detail` may contain business data: take care when saving or sharing logs. Diagnostic events do not print connection passwords.

### Output language

The CLI defaults to English and does not switch based on the system's `LANG`. Set `language: "zh-CN"` in `defineConfig({...})` to make Chinese the project default. To use Chinese for a single command:

```sh
npx tgm --help --lang zh-CN
npx tgm deploy --lang zh-CN
npx tgm status --lang zh-CN --detail
```

The precedence is **`--lang` > configuration `language` > `en`**. For example, `tgm deploy --lang en` uses English once in a project configured for Chinese. `--help` and unknown commands do not load the project configuration, so add `--lang zh-CN` explicitly for Chinese help or errors in those paths. `--detail` works with either language. All tool-authored explanations follow the selected language, including configuration validation, history checks, DDL limitations, locks, transaction failures and drift descriptions. SQL, identifiers, paths, commands and error codes retain their original spelling. Known upstream model errors and common driver error codes receive localized explanations. Unrecognized external errors receive a localized summary; use `--detail` to include the original diagnostic text for troubleshooting.

Model names use PascalCase, for example `model("SysUser", ...)`; a table-style name such as `sys_user` is not a valid model name. Upstream 0.0.13 accidentally prints the lowercase property-name regex in this error, although model validation requires an uppercase first letter. Model validation errors do not receive an ESM hint; only module-format failures do. Missing files or dependencies receive a path/install hint instead.

To retain the database table name `sys_user`, configure it in the fourth argument:

```ts
export const SYS_USER = model("SysUser", "id", class {
  id = prop.i64();
}, (ctx) => ctx.table("sys_user"));
```

## Behavior

- **History validation:** `dev` and `deploy` reject changed or missing applied files. `dev` refuses to generate while pending files exist; apply them with `deploy` first.
- **Independent indexes and comments are not managed by models:** custom migration indexes are preserved while their columns remain. Explicit programmatic schemas may manage indexes; removing a unique index is flagged as destructive.
- **Migration files are readable SQL:** `<migrationsDir>/<timestamp>_<name>.sql` can be edited before application. **Do not edit an applied migration.** `deploy` rejects a changed checksum; make a new migration instead.
- **Destructive changes require confirmation:** dropping tables or columns, changing column types, and explicit unique-index removal prompt during model synchronization; non-interactive synchronization requires `--force`. `deploy` applies reviewed SQL files without confirmation.
- **Post-migration checks:** `dev` and `deploy` reread the schema and warn about remaining differences. `push` returns 1 if differences remain after synchronization; cancellation also returns 1. `check` returns 1 for differences, including CHECK constraints whose equivalence cannot be proven. For example:

  ```text
  Warning: postgres/app/public differs from the model:
    - Table AUTHOR: Extra column LEGACY
  Check for a partial migration or manual database changes.
  ```

- **Concurrency protection:** a process lock prevents parallel migrations in one project; a database lock protects deployments across machines.
- **Target schema applies to reads and writes:** PostgreSQL uses `search_path`, while SQL Server and Oracle qualify target tables. This prevents introspection and DDL from targeting different schemas.

## License

Original code uses [MIT](LICENSE). ts-grm uses Apache-2.0; adapted upstream structure types retain their license and attribution. See [third-party notices](THIRD_PARTY_NOTICES.md).

## More documentation

- [Review, custom SQL, transaction rollback, and recovery](docs/migrations.md)
- [Compatibility and supported ts-grm versions](docs/compatibility.md)
- [Design and migration internals](docs/design.md)
- [Contributing](CONTRIBUTING.md)
- [Security and support](SECURITY.md)
- [Release process](docs/releasing.md)
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
