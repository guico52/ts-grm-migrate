# Changelog

English | [简体中文](docs/zh-CN/CHANGELOG.md)

## 0.1.0-alpha.1 (pending publication)

- Make CLI output concise and English by default, with `--detail` diagnostics, `--lang zh-CN` Chinese messages, and a configuration setting for the default language.
- Reduce default test output while retaining failure reasons and post-migration drift warnings.
- Remove the automatic GitHub Actions workflow; maintainers now run pre-release verification and publishing manually.
- Make English the primary documentation language and provide corresponding Simplified Chinese documents.

## 0.1.0-alpha.0

- Add basic PostgreSQL and SQLite migrations and MySQL, SQL Server, and Oracle dialects.
- Add durable unfinished-migration state, transactional success recording, exclusive migration-file creation, and stable database locks.
- Add historical ts-grm compatibility checks, isolated package tests, and container database test scripts.
- Align the development toolchain with ts-grm, use MIT for original code, and retain third-party adaptation notices.

No stable version has been released. See the [README](README.md) for database support boundaries. Future releases will record breaking changes and recovery steps here.
