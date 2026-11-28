# Reviewing and applying migrations

English | [简体中文](zh-CN/migrations.md)

Start from an empty database, or adopt supported existing tables using `baseline` and an explicit table management scope. Models must be supplied; reverse model generation is not supported.

## Adopt existing databases and exclude tables

```ts
export default defineConfig({
  dialect: 'postgres',
  database: { connectionString: process.env.DATABASE_URL },
  models: ['./src/models'],
  excludeTables: ['sys_*', /^archive_\d{6}$/, 'external_users'],
});
```

`excludeTables` accepts `(string | RegExp)[]` matching **physical table names** within the configured database/schema. Strings are full-name, case-sensitive globs. RegExp follows native JavaScript semantics: use `i` for case-insensitive matching and `^`/`$` to anchor the whole name. Stateful `g` and `y` flags are rejected. Any matching pattern excludes the table. Excluded tables are skipped by `dev`, `push`, `check`, and post-deploy drift checks, before unsupported structures are parsed. Excluded tables may remain in models for application queries; their existence and structural differences are ignored by tgm, and missing excluded tables are not created. The history table is always reserved. Other tables retain authoritative comparison: removing a model or finding database tables without models is still reported as drift, but only generates drops with explicit `allowDropTables: true`.

String globs support `sys_*` (prefix), `*_log` (suffix), `report_????` (four characters), `report_[0-9][0-9]` (two digits), and `{order,payment}_*` (alternative prefixes). `*` and `?` do not cross `/`. Names are strings, not directories; `sys_**` is equivalent to `sys_*`. Leading `!` negation and extglob are not supported; parentheses and pipes in strings are literal, so use RegExp for complex expressions. To match a literal `*`, write `'sys_\\*'` in TypeScript. Unbalanced brackets/braces are rejected before operations start.

```ts
excludeTables: [
  'sys_*',                       // System tables
  /^order_(?:2025|2026)_\d{2}$/, // Monthly shards owned by another system
  /^tenant_\d+_audit$/i,         // Tenant audit shards
]
```

New physical shards matching the patterns are automatically excluded. Patterns only select the management scope: they do not expand one logical model into multiple physical tables or provide shard routing. Configure separate connections and run migrations independently for each database shard. Patterns do not match database or schema names.

1. Supply ts-grm models matching the tables to adopt and configure excluded tables.
2. Run `npx tgm check` and align any reported differences.
3. With an empty migration directory and history, run `npx tgm baseline -n initial`.
4. Commit models, configuration and SQL; continue with `dev --create-only`, review and `deploy`.

`baseline` generates creation SQL from the managed database state, preserving representable defaults and independent indexes, and records it as already applied. It does not execute business creation SQL or modify business data; it initializes the migration history table. Model differences in managed attributes, an empty managed schema, or existing files/history block adoption. Only structures represented by the current introspectors/DDL are supported. Business data, triggers, views, custom functions and other database objects are not exported; prepare separate initialization SQL for these objects and custom default dependencies. PostgreSQL serial is represented by identity on replay; generator counters and other sequence settings are not copied.

On a fresh database, `deploy` executes the baseline. Excluded tables must be provisioned by their owner. On other existing environments with the same structure, run `check` with the same configuration, review and verify the baseline SQL against their state, then use `resolve --applied <baseline-id>`. If recording history fails during adoption, the generated file remains; verify structure and history before using the same recovery command. Do not deploy that creation file directly against existing tables.

The first version restricts cross-boundary foreign keys conservatively: a managed table referencing an excluded table blocks comparison/adoption. An excluded table referencing a managed table permits a matching baseline/check but blocks generated structural changes to the referenced table until dependencies are handled manually. Custom `Introspector` implementations must honor early filtering and the `onExcludedReference` callback in `IntrospectionOptions`.

Exclusions do not rewrite existing SQL. `deploy` still executes migration files, including custom SQL. Review pending files when changing scope. Adding exclusions preserves files/history; removing exclusions resumes authoritative comparison.

## Control automatic table deletion

Available since `0.1.0-alpha.9`; `baseline` and pattern-based exclusions are available since `0.1.0-alpha.8`. Published `0.1.0-alpha.9` defaults to `true`; the next unreleased version changes the default to `false`. To retain automatic table deletion after upgrading, explicitly configure `allowDropTables: true`.

```ts
export default defineConfig({
  database: { connectionString: process.env.DATABASE_URL },
  models: ['./src/models'],
  allowDropTables: false,
});
```

`allowDropTables` is a boolean and defaults to `false` in the next unreleased version. Only explicit `true` enables automatic table drops. When omitted or `false`, `dev` (including `--create-only`) and `push` (including `--dry-run`) omit table drops from both generated SQL and destructive-change confirmations. Other operations, including creating tables, adding/dropping columns, and changing constraints/indexes, remain enabled. `--force` does not override this setting. Programmatic callers can pass the same option to `Migrator`.

This controls DDL generation, not management scope. `check` and post-application drift checks still report non-excluded tables absent from models. `push` exits with 1 if those differences remain; `dev` reports remaining differences and writes no empty migration when the only changes would be table drops. `baseline` still requires matching managed structures and will not silently include extra tables. Use `excludeTables` instead when those tables should be completely outside tgm's scope.

Existing SQL is not rewritten: `deploy` still executes a `DROP TABLE` already present in a migration file, even with `allowDropTables: false`. Retained tables stay in the DDL dependency context so foreign keys can be restored after changes to referenced keys; database dependency checks and the existing cross-scope guards still apply.

## Generate, review, apply

```sh
npx tgm dev --create-only -n init
# Review the generated SQL in migrationsDir; edit it if necessary.
npx tgm deploy
npx tgm check
```

`--create-only` writes one pending SQL file without executing its SQL or creating migration history. Runtime connection setup can initialize the target schema or an empty SQLite file. It does not require destructive-change confirmation because it does not apply the change. Review the file before `deploy`: deployment applies pending files without interactive confirmation.

`dev` and `dev --create-only` both validate applied-file checksums and missing files. They refuse to generate another migration while pending files exist; run `deploy` first. This also applies after pulling a teammate's migrations. After deployment, never edit the applied file; add a new migration instead.

`dev` without `--create-only` remains the shortcut for generating and applying a migration immediately. `push` synchronizes the current model-managed structure and writes no history. Pending, failed, missing or modified migration files block it; resolve the migration workflow first. `push --dry-run` previews the SQL without creating schemas or writing database/history state (an existing SQLite file is required). Applied migrations must form a continuous prefix of the ordered files. To start reproducible migration history after experimenting with `push`, use `baseline` once the database matches the models and migration files/history are empty.

## Custom SQL and unsupported automatic changes

You may add an SQL file directly to `migrationsDir`, including for data-only changes. Use a unique ID that sorts after every existing migration, normally a 17-digit UTC timestamp followed by a name:

```text
<migrationsDir>/20261009080000000_backfill.sql
```

This is an example ID: choose a fresh timestamp and verify the order with `tgm status`. Commit models and migration files together. The filename without `.sql` is the migration ID used by `resolve`.

For a PostgreSQL text-to-integer conversion, first try `dev --create-only` and edit the generated statement to express the conversion explicitly:

```sql
alter table "item" alter column "quantity" type integer
  using "quantity"::integer;
```

For a non-null column on a table containing rows, use an appropriate staged change: add a nullable column, backfill data, then set `NOT NULL`. For a rename, update the model and replace the generated drop/add statements with explicit rename SQL that preserves the data.

Some changes, including SQLite rebuilds and PostgreSQL / SQL Server / Oracle identity changes, are rejected before an SQL file can be generated. Create the SQL file manually and apply it through `deploy`. A safe SQLite rebuild must preserve rows, incoming foreign keys, indexes, and triggers. An identity change must account for existing values and the generator's next value. Test custom SQL against an isolated database that has the preceding migrations applied.

If SQL was already executed manually, create the corresponding file and run:

```sh
npx tgm resolve --applied 20261009080000000_backfill
npx tgm check
```

`resolve --applied` records the file and its checksum; it does not execute or validate its SQL.

## Failure recovery and transactions

PostgreSQL, SQLite, and SQL Server automatically roll back the current migration transaction when SQL or success-recording fails. Each migration file is its own transaction: earlier successfully applied files remain applied when a later file fails. An unfinished attempt is persisted before execution and remains a recovery guard even when rollback succeeded.

MySQL and Oracle DDL commits implicitly; earlier statements in the failed file may remain applied. Inspect the actual state before resolving. If the migration was completed manually, use `resolve --applied`. If its effects were undone, use `resolve --rolled-back`, then retry `deploy`. `resolve --rolled-back` changes history only and never undoes SQL. Automatic reversal of an already successful migration is not provided.

## Management scope and checks

Model tables, columns, and constraints are authoritative. Without `ts-grm-patches`, defaults and identity are not managed. With the companion package, these attributes become authoritative too. Independent indexes and comments have no model declaration source and are not managed by model synchronization. An index added through a custom migration survives later model synchronization, provided its columns remain. Explicit programmatic schemas can opt into index management with `indexesManaged: true`; removing a unique index is flagged as potentially destructive.

```sh
npx tgm check       # 0: model matches; 1: drift or an error
```

`check` reads the database without creating schemas, changing tables, or writing history. For SQLite it requires the specified file to exist. `dev` and `deploy` report remaining drift as a warning. `push` returns 1 if the post-sync comparison still finds differences. Cancellation returns 1. CHECK differences are reported too: unproven expression equivalence is not silently ignored. Conservative comparisons can report equivalent expressions; inspect these cases rather than assuming every warning is a migration failure.

There is deliberately no shadow database. Replaying a second database would add provisioning, permissions, execution time, and dialect-specific management to a small ORM companion. The chosen checks cover applied-file integrity and database-versus-model differences; they do not prove that all migration history reproduces the database. Validate releases by applying the full history to an isolated empty database yourself.

Supported CHECK expressions round-trip through catalog formatting; other expressions are compared conservatively. SQLite retains NUMERIC affinity separately from REAL, reads CHECK constraints and partial index predicates, and drops referencing tables before their parents. Cyclic table drops are rejected. Special indexes are retained outside model index management, but operations that could rewrite their columns or manage those indexes are rejected. Generated/hidden columns and unsupported constraint semantics are rejected rather than flattened into ordinary structures.

Local locks use atomic renewable directory leases (`proper-lockfile`); crashed leases expire after 10 seconds. PostgreSQL holds the lock and runs all work on the same session. SQLite file databases additionally lock the canonical file path across checkouts; Native better-sqlite3 filenames are detected automatically; wrappers without a `name` must supply the file path as the second `SqliteSqlExecutor` constructor argument. Never remove a live lease manually.
