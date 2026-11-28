# Design

English | [简体中文](zh-CN/design.md)

See the [README](../README.md) for usage and database limitations. This page describes the main code boundaries when changing migration behavior.

## From models to SQL

`src/runtime.ts` assembles both CLI and programmatic entry points. It creates a ts-grm `SqlClient` and lazily loads `models` through `src/model-loader.ts` before converting them to the migrator's `Schema`. Imports use `pathToFileURL`, including on Windows; `status` and `resolve` do not import model files:

```text
ts-grm models → src/vendor/ts-grm.ts → src/schema/adapter.ts → Schema
                                                       ↕
database → introspector → Schema → differ → DDL generator → executor
                                                       ↕
                                              migration files / history
```

`src/vendor/ts-grm.ts` is the only place that reads upstream's internal `tableDefs`. The upstream public `Schema` type has no structured table definitions, so this adapter must be verified across supported peer versions. `src/dialect.ts` defines dialect names and support status; reading, DDL, and execution are implemented in `src/introspector/`, `src/ddl/`, and `src/executor/`.

The ts-grm model registry is a process-level singleton. The CLI loads models in a separate process; programmatic callers should avoid mixing unrelated model sets in one process.

## Diff rules

`src/differ.ts` compares database and target models after both are converted to `Schema`. Columns match by name; constraints and indexes match by content because generated names may be unstable; column order is ignored.

The migrator reads column defaults and auto-increment from the model when the optional `ts-grm-patches` package is installed (`applyPatches()`, see `src/schema/patches.ts`). In that mode the model is authoritative for both attributes: a column without `default(...)` is target state "no default", and `autoIncrement()` participates in diffing through the `autoIncrementManaged` flag. Without the patch neither attribute is managed, so defaults and identity columns that exist only in the database are left alone. Column comments are never managed. Target constraints remain authoritative. Model-derived tables set `indexesManaged: false`, preserving independent indexes; explicit programmatic targets can manage them. Default comparison lives in `src/schema/defaults.ts` and uses column types and dialects with exact numeric comparison. Getter failures abort adaptation. Polymorphic model fields become ordinary columns and database constraints during adaptation and no longer retain their ts-grm semantics.

SQLite cannot read constraint names, making content-based comparison essential. Some CHECK expressions are reformatted by the database, so equivalent expressions may still appear changed. Add real database tests before widening expression normalization.

## Table management scope

`src/table-filter.ts` compiles `excludeTables` once per operation: strings are full-name globs and RegExp uses native matching without stateful `g`/`y` flags. Each dialect filters excluded catalog rows before unsupported structures are parsed, while retaining incoming foreign-key dependencies through `onExcludedReference`.

`Migrator` filters both the database state and target models before diffing and passes the filtered schemas to DDL generation. Excluded tables can stay in query models; missing tables and structural differences are ignored. The history table is always reserved. Managed tables referencing excluded tables are rejected, and excluded tables referencing managed tables block generated structural changes to those referenced tables. Existing SQL files still execute as written.

## Migrations and recovery

`src/migrator.ts` manages `baseline`, `dev`, `deploy`, `push`, and `resolve`; `dev --create-only` generates files without applying them. `dev`, `deploy` and `push` share history integrity and ordered-prefix validation; pending files block new generation. PostgreSQL DDL orders dependency removal, table/column changes, keys/indexes, then foreign keys. Migration files are created exclusively, and checksums detect edits to applied files. An unfinished record is written before execution. After an interruption or history-recording failure, subsequent deployment will not replay automatically; inspect the database and use `resolve`.

`baseline` requires empty migration files/history and a matching managed schema. It creates initial SQL from database introspection, writes the file, then records it as applied without executing its business DDL. A history-write failure leaves the file for verified recovery with `resolve --applied`. It uses the same process/database locks as other migration operations.

`src/lock.ts` limits local concurrency within a project, and database locks limit concurrency across machines. PostgreSQL, SQLite, and SQL Server record migration SQL and success in one transaction. MySQL and Oracle DDL may commit implicitly; after failure, recovery must follow the actual database state.

`src/drift.ts` rereads the database after migration and compares it with the current model. It does not replay every migration file, so it cannot prove that history and database have never diverged. Applied-file checksum checks detect file modification.

SQLite changes that require table rebuilding currently fail explicitly. A safe rebuild also needs to handle external foreign keys, indexes, and data migration; simply renaming the old table is insufficient. See the [README](../README.md#databases-and-configuration) for other dialect limitations.

## Verifying changes

Run `corepack yarn check` for static checks, build, and local tests. Database tests use `corepack yarn test:postgres-mysql` and `corepack yarn test:servers`; ordinary tests skip those cases when the database environment is absent. See [compatibility](compatibility.md) for version-range validation.

The lifecycle starts with an empty database or a verified baseline of supported existing tables. `excludeTables` defines unmanaged physical tables; cross-boundary foreign keys are conservatively restricted. Shadow databases are deliberately omitted to avoid provisioning and replay costs. `check` is a read-only strict model comparison and does not replay migration history. See [migration workflows](migrations.md).
