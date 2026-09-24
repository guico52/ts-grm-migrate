# Third-party notices

本项目原创代码使用 MIT，见 [LICENSE](LICENSE)。依赖和适配部分保留其各自许可证。

## ts-grm

`src/vendor/ts-grm.ts` 中的 `TableDef`、`ColumnDef` 和约束类型声明改写自 ts-grm 的
`schema_def.ts`：保留迁移器需要的字段，调整类型名称和引用，并添加本项目的适配接口及实现。
上游文件署名为陈涛 (Chen Tao)，上游包标记为 Apache-2.0。改写部分保留其许可与署名；
本项目其余原创代码使用 MIT。

- @see https://github.com/babyfish-ct/ts-grm/blob/fe78eb6c323bf335ff23650a414856eb36bfbce7/packages/sql/src/impl/schema_def.ts
- @see https://github.com/babyfish-ct/ts-grm/blob/fe78eb6c323bf335ff23650a414856eb36bfbce7/packages/sql/package.json
- [Apache-2.0 全文](LICENSES/Apache-2.0.txt)

发布包将 `@ts-grm/core` 和 `@ts-grm/sql` 保留为外部 peerDependencies，不嵌入上游实现。
其他数据库驱动也为外部依赖，其许可证由各自包提供。
