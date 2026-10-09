# Reviewing and applying migrations

English | [简体中文](zh-CN/migrations.md)

This tool targets new ts-grm applications: create an empty database, generate the initial migration, and evolve that database with subsequent model changes. Adopting an existing application's database, introspecting models from a database, and baselining pre-existing tables are outside the current scope.

## Generate, review, apply

```sh
npx tgm dev --create-only -n init
# Review the generated SQL in migrationsDir; edit it if necessary.
npx tgm deploy
npx tgm check
```

`--create-only` writes one pending SQL file without executing its SQL or creating migration history. Runtime connection setup can initialize the target schema or an empty SQLite file. It does not require destructive-change confirmation because it does not apply the change. Review the file before `deploy`: deployment applies pending files without interactive confirmation.

`dev` and `dev --create-only` both validate applied-file checksums and missing files. They refuse to generate another migration while pending files exist; run `deploy` first. This also applies after pulling a teammate's migrations. After deployment, never edit the applied file; add a new migration instead.

`dev` without `--create-only` remains the shortcut for generating and applying a migration immediately. `push` is intended for disposable experimentation and writes no history. To start reproducible migration history after experimenting with `push`, generate the initial migration against a fresh empty database.

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

`check` reads the database without creating schemas, changing tables, or writing history. For SQLite it requires the specified file to exist. `dev`, `deploy`, and `push` report remaining drift as a warning and retain their successful execution exit code. CHECK differences are reported too: unproven expression equivalence is not silently ignored. Conservative comparisons can report equivalent expressions; inspect these cases rather than assuming every warning is a migration failure.

There is deliberately no shadow database. Replaying a second database would add provisioning, permissions, execution time, and dialect-specific management to a small ORM companion. The chosen checks cover applied-file integrity and database-versus-model differences; they do not prove that all migration history reproduces the database. Validate releases by applying the full history to an isolated empty database yourself.
