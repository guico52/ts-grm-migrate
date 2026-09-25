# Design

English | [简体中文](zh-CN/design.md)

See the [README](../README.md) for usage and database limitations. This page describes the main code boundaries when changing migration behavior.

## From models to SQL

`src/runtime.ts` assembles both CLI and programmatic entry points. It loads `models`, creates a ts-grm `SqlClient`, and converts the models to the migrator's `Schema`:

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

The migrator does not remove column defaults or comments that are absent from the model. Auto-increment strategies the model cannot express are excluded from diffing, while target constraints and indexes remain authoritative. Polymorphic model fields become ordinary columns and database constraints during adaptation and no longer retain their ts-grm semantics.

SQLite cannot read constraint names, making content-based comparison essential. Some CHECK expressions are reformatted by the database, so equivalent expressions may still appear changed. Add real database tests before widening expression normalization.

## Migrations and recovery

`src/migrator.ts` manages `dev`, `deploy`, `push`, and `resolve`. Migration files are created exclusively, and checksums detect edits to applied files. An unfinished record is written before execution. After an interruption or history-recording failure, subsequent deployment will not replay automatically; inspect the database and use `resolve`.

`src/lock.ts` limits local concurrency within a project, and database locks limit concurrency across machines. PostgreSQL, SQLite, and SQL Server record migration SQL and success in one transaction. MySQL and Oracle DDL may commit implicitly; after failure, recovery must follow the actual database state.

`src/drift.ts` rereads the database after migration and compares it with the current model. It does not replay every migration file, so it cannot prove that history and database have never diverged. Applied-file checksum checks detect file modification.

SQLite changes that require table rebuilding currently fail explicitly. A safe rebuild also needs to handle external foreign keys, indexes, and data migration; simply renaming the old table is insufficient. See the [README](../README.md#databases-and-configuration) for other dialect limitations.

## Verifying changes

Run `corepack yarn check` for static checks, build, and local tests. Database tests use `corepack yarn test:postgres-mysql` and `corepack yarn test:servers`; ordinary tests skip those cases when the database environment is absent. See [compatibility](compatibility.md) for version-range validation.
