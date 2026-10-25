/** schema 适配、introspect 和 SQL 生成共用的 MySQL 基础工具。 */
import { createHash } from 'node:crypto';

export function quoteMysqlIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``;
}

/** runtime 启用 NO_BACKSLASH_ESCAPES，字面量只有一种无歧义的编码。 */
export function quoteMysqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 整数显示宽度不属于存储类型；保留 unsigned / zerofill。 */
export function normalizeMysqlType(type: string): string {
  // enum/set 的取值是区分大小写的数据，不是类型关键字。
  if (/^(enum|set)\(/i.test(type)) return type;
  return type
    .toLowerCase()
    .replace(/\s*,\s*/g, ',')
    .replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/g, '$1')
    .replace(/^integer\b/, 'int')
    .replace(/\s+/g, ' ')
    .trim();
}

/** MySQL 标识符最长 64 个字符；用后缀区分被截断的长名称。 */
export function mysqlName(name: string): string {
  return name.length <= 64
    ? name
    : `${name.slice(0, 47)}_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

/** 对表达式分词，不改写引号内的数据和标识符内容。 */
export function normalizeMysqlCheck(expression: string): string {
  const tokens =
    expression.match(
      /'(?:''|[^'])*'|`(?:``|[^`])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|<>|!=|<=|>=|[^\s]/g,
    ) ?? [];
  // 服务器会给 CHECK 字面量加外层括号和字符集前缀。
  while (tokens[0] === '(' && tokens.at(-1) === ')') {
    let depth = 0;
    const wraps = tokens.every((t, i) => {
      if (t === '(') depth++;
      if (t === ')') depth--;
      return depth > 0 || i === tokens.length - 1;
    });
    if (!wraps) break;
    tokens.shift();
    tokens.pop();
  }
  return tokens
    .filter(
      (t, i) =>
        !/^_(utf8mb4|utf8mb3|utf8|latin1|ascii|binary)$/i.test(t) ||
        !tokens[i + 1]?.startsWith("'"),
    )
    .map((t) =>
      t.startsWith("'")
        ? t
        : t.startsWith('`')
          ? t.slice(1, -1).replaceAll('``', '`').toLowerCase()
          : t.toLowerCase(),
    )
    .join(' ');
}
