# Contributing

English | [简体中文](docs/zh-CN/CONTRIBUTING.md)

This project is in alpha. When filing an issue, include a minimal model and the database, driver, Node, `@ts-grm/core`, and `@ts-grm/sql` versions. Remove credentials and application data.

## Development and verification

The development toolchain follows ts-grm: Yarn 4.1.0, TypeScript 7, tsdown, Biome, and Vitest 4. Node `>=24.11.0` is required by the published upstream `using` syntax and the current tsdown runtime. Verify releases on Node 24.11 and the current Node 24 release. The upstream repository's Node >=18 declaration does not satisfy this project's build tools and SQLite driver.

```sh
corepack enable
corepack yarn install --immutable
corepack yarn check
corepack yarn test:package 0.0.9
corepack yarn test:package 0.0.13
corepack yarn test:compat 0.0.9 0.0.13
corepack yarn test:postgres-mysql
corepack yarn test:servers
```

`check` runs lint, type checking, the build, and local tests. Server tests are skipped when their database environment variables are absent, so this is not a complete database verification. The two container scripts use Podman by default; set `CONTAINER_RUNTIME=docker` to use Docker. They create temporary containers on random ports and clean up only their own resources. Allow space for the images and do not test against an application database.

`TS_GRM_TEST_VERSION=0.0.9 corepack yarn test:servers` installs that historical version in an isolated directory before running real database tests. Compatibility checks do not alter repository dependencies or the lockfile. See [compatibility](docs/compatibility.md) for the supported range and reproduction steps.

## Changes

- A new dialect must cover model adaptation, introspection, DDL, execution, history, locking, and documentation.
- Verify the schema → SQL → introspection → diff cycle, including data preservation, failure recovery, and concurrency.
- Reject unsupported database structures explicitly instead of silently dropping them.
- Keep access to ts-grm internals in `src/vendor/ts-grm.ts`; verify candidate versions before changing the peer range.
- Keep the published package ESM and ts-grm external to the bundle so the host model registry is shared.
- Mark external implementation references with `@see` and retain applicable licenses and attribution for adopted code.
- Biome follows upstream formatting preferences. `yarn check` runs correctness lint without wholesale formatting of historical code.

Original contributions use MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for adapted code.

`yarn test:coverage` uses V8 to generate source coverage and LCOV, excluding test fixtures. Coverage from local tests alone does not represent coverage of every dialect; there is currently no global threshold based on a single coverage figure.
