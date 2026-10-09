# Releases

English | [简体中文](zh-CN/releasing.md)

`ts-grm-migrate` is published to npm as an alpha package. The maintainer releases it manually; the repository has no automatic GitHub Actions verification or publishing workflow.

Before each release:

1. Update the version in `package.json` and [CHANGELOG.md](../CHANGELOG.md). A version cannot be republished. Before expanding the peer range, revalidate it as described in [compatibility](compatibility.md).
2. On Node 24.11 and the current Node 24 release, run `corepack yarn install --immutable`, `corepack yarn check`, `corepack yarn test:package 0.0.9`, and `corepack yarn test:package 0.0.13`. For changes to database migration behavior, also run `corepack yarn test:postgres-mysql` and `corepack yarn test:servers`.
3. Run `npm publish --dry-run --tag next` and inspect entry points, type declarations, licenses, third-party notices, and the README. Confirm the worktree state and version to be published.
4. The maintainer signs in to npm, runs `npm publish --tag next`, and then checks the npm registry for the version and dist-tag.

Confirm that the `repository`, `bugs`, and `homepage` URLs in `package.json` point to the maintained repository. Check Git history and the package contents for credentials and local configuration before publishing.

Column-patch changes must pass the companion tests at `0.0.13` in addition to base compatibility at `0.0.9`. Confirm `--create-only` writes no history, `check` has no database writes, and independent indexes survive model evolution. Apply the complete history to an isolated empty database before releasing changes to generated SQL.
