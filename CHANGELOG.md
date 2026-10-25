# Changelog

English | [简体中文](docs/zh-CN/CHANGELOG.md)

## 0.1.0-alpha.7 (pending publication)

- Restore the SQLite introspection lost in 0.1.0-alpha.6: CHECK constraints, parent primary-key columns for foreign keys without explicit references, partial index predicates, explicit rejection of unsupported table/column/index structures, and NUMERIC affinity. Users of 0.1.0-alpha.6 with SQLite should upgrade.
- Failure logs state that a transaction was rolled back only when the executor confirms it, instead of matching error text. SQLite now reports an unconfirmed rollback when `ROLLBACK` itself fails.
- Document that programmatic `dev()` and `push()` apply destructive changes without asking unless a `confirm` hook is supplied.
- Enforce Biome's recommended lint rules and formatting in `check`; code comments are now written in Chinese.

## 0.1.0-alpha.6 (2026-10-20)

- Add explicit `tgm seed` with executable/argument configuration, literal argument forwarding after `--`, local binary lookup, inherited environment and terminal I/O, exit-code propagation and interruption handling.
- Keep seeding independent of migration runtime, schema changes and history; add bilingual examples and subprocess/SQLite integration tests.
- **Known issue:** this release accidentally reverted the SQLite introspection hardening from 0.1.0-alpha.5. SQLite CHECK constraints are regenerated on every `dev`, foreign keys referencing an implicit primary key are misread, and unsupported structures are not rejected. Fixed in 0.1.0-alpha.7.

## 0.1.0-alpha.5 (2026-10-11)

- Add `push --dry-run`. `push` is blocked by pending, failed, missing or modified migration files, and returns 1 when differences remain after synchronization or the user cancels. Applied migrations must form a continuous prefix of the ordered files.
- Round-trip supported CHECK expressions through catalog formatting and compare other expressions conservatively.
- SQLite keeps NUMERIC affinity separate from REAL, reads CHECK constraints and partial index predicates, drops referencing tables before their parents, and rejects cyclic drops, generated/hidden columns, special indexes that would be rewritten, and unsupported constraint semantics.
- Use atomic renewable directory leases (`proper-lockfile`) for local locks; crashed leases expire after 10 seconds. PostgreSQL runs the lock and all migration work on one session; SQLite file databases also lock the canonical file path.
- Document running the CLI in workspaces with non-hoisted dependencies (`npx --workspaces=false tgm`).

## 0.1.0-alpha.4 (2026-10-09)

- Localize configuration, history, locking, DDL, transaction and drift explanations throughout the CLI; preserve technical identifiers and expose original external diagnostics with `--detail`.
- Explain model naming errors in the selected language and restrict ESM troubleshooting hints to module-format failures.

## 0.1.0-alpha.3 (2026-10-09)

- Add `dev --create-only` and read-only `check`, validate history before development generation, preserve unmanaged indexes, order PostgreSQL dependencies, and handle MySQL identity/default changes together.
- Compare defaults by dialect and column type without numeric precision loss; abort on patch metadata errors; report all unproven CHECK differences.
- Support column-level `default` and `autoIncrement` declared through the optional [`ts-grm-patches`](https://www.npmjs.com/package/ts-grm-patches) package, including the matching DDL for PostgreSQL, MySQL, SQLite, SQL Server, and Oracle, and normalize catalog default forms (`::type` casts, parentheses, `N` prefixes, numeric quoting) so migrations are not regenerated.
- Repair isolated companion compatibility tests and add bilingual migration review, custom SQL, transaction recovery, and scope documentation.

## 0.1.0-alpha.2

Removed from the npm registry; not available for installation.

## 0.1.0-alpha.1 (2026-09-26)

- Make CLI output concise and English by default, with `--detail` diagnostics, `--lang zh-CN` Chinese messages, and a configuration setting for the default language.
- Reduce default test output while retaining failure reasons and post-migration drift warnings.
- Remove the automatic GitHub Actions workflow; maintainers now run pre-release verification and publishing manually.
- Make English the primary documentation language and provide corresponding Simplified Chinese documents.

## 0.1.0-alpha.0 (2026-09-24)

- Add basic PostgreSQL and SQLite migrations and MySQL, SQL Server, and Oracle dialects.
- Add durable unfinished-migration state, transactional success recording, exclusive migration-file creation, and stable database locks.
- Add historical ts-grm compatibility checks, isolated package tests, and container database test scripts.
- Align the development toolchain with ts-grm, use MIT for original code, and retain third-party adaptation notices.

No stable version has been released. See the [README](README.md) for database support boundaries. Future releases will record breaking changes and recovery steps here.
