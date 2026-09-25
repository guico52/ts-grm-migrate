# Compatibility

English | [简体中文](zh-CN/compatibility.md)

See the [README](../README.md) for installation requirements and database support. This page explains the `@ts-grm/core` / `@ts-grm/sql` peer range and how to revalidate it.

The two ts-grm packages must use the same version. The supported range is `>=0.0.9 <0.0.14`; `0.0.9` is the minimum version that passed full model type checking and local tests. Versions `0.0.1`–`0.0.8` lack APIs required by the test models and are excluded. Do not expand the range based only on a local checkout: install the artifacts published to npm for verification.

Versions `0.0.9` and `0.0.13` passed isolated package tests and were verified against PostgreSQL 17, MySQL 8.4, SQL Server 2022, and Oracle Free 23. Intermediate versions passed type checking and local tests but have not each been tested against every real database combination. Revalidate both the minimum and maximum target versions when expanding the peer range.

```sh
corepack yarn install --immutable
corepack yarn test:compat 0.0.9 0.0.13
corepack yarn test:package 0.0.9
corepack yarn test:package 0.0.13
TS_GRM_TEST_VERSION=0.0.9 corepack yarn test:postgres-mysql
TS_GRM_TEST_VERSION=0.0.9 corepack yarn test:servers
```

`test:compat` installs specified versions in temporary directories and runs type checking with full models and local tests. It writes a temporary JSON report, or to the path specified by `COMPAT_REPORT`. The database scripts require Podman; set `CONTAINER_RUNTIME=docker` to use Docker. Check the minimum and current peer versions manually before release.

The minimum Node version is `24.11.0`. The published `@ts-grm/sql@0.0.13` artifact contains `using` declarations; the checked Node versions 22.18.0, 22.22.3, and 22.23.2 could not parse that syntax. This project does not transform the upstream artifact, so it does not claim Node 22 support. If upstream build output or Node changes, retest in a clean environment before adjusting `engines`.

The migrator reads the internal `tableDefs` of objects returned by ts-grm. These fields are not part of an upstream public type guarantee. Inspect `src/vendor/ts-grm.ts` and run the compatibility matrix when changing versions.
