/**
 * ts-grm 依赖的唯一入口（适配层）。
 *
 * 约定：migrate 源码中所有对 `@ts-grm/*` 的 import 必须经过本文件，
 * 禁止在业务代码里直接 `import ... from "@ts-grm/sql"` 等。
 *
 * 原因：当前通过 yarn workspace 协议引用 ts-grm 本地仓库（见 README「依赖接入」）；
 * 等 ts-grm 发布 npm 后，把 package.json 的依赖换成版本号即可，本文件是唯一的
 * 代码修改点。注意：ts-grm 作者很可能在发布时修改包名，届时同样只需改本文件的
 * 导入源。
 */
export { newSqlClient } from "@ts-grm/sql";
export type { SqlClientOptions } from "@ts-grm/sql";
