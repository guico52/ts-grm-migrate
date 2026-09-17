/**
 * 数据库交互的基础类型。
 *
 * `SqlQueryable` 是最小的「执行 SQL 并拿到行」能力：pg 的 Pool / Client 天然满足，
 * 测试可注入假实现。introspector 与 executor 都以它为公共底座。
 */
export interface SqlQueryable {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }>;
}
