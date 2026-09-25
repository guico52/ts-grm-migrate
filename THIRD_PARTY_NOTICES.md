# Third-party notices

English | [简体中文](docs/zh-CN/THIRD_PARTY_NOTICES.md)

Original code in this project is under the [MIT license](LICENSE). Dependencies and adapted portions retain their respective licenses.

## ts-grm

The `TableDef`, `ColumnDef`, and constraint type declarations in `src/vendor/ts-grm.ts` were adapted from ts-grm's `schema_def.ts`. They retain the fields needed by the migrator, change type names and references, and add this project's adapter interfaces and implementation. The upstream file credits Chen Tao, and the upstream package is licensed under Apache-2.0. The adapted portion retains that license and attribution; the project's other original code uses MIT.

- @see https://github.com/babyfish-ct/ts-grm/blob/fe78eb6c323bf335ff23650a414856eb36bfbce7/packages/sql/src/impl/schema_def.ts
- @see https://github.com/babyfish-ct/ts-grm/blob/fe78eb6c323bf335ff23650a414856eb36bfbce7/packages/sql/package.json
- [Full Apache-2.0 license](LICENSES/Apache-2.0.txt)

The published package keeps `@ts-grm/core` and `@ts-grm/sql` as external peer dependencies; it does not bundle upstream implementations. Database drivers are external dependencies with their own licenses.
