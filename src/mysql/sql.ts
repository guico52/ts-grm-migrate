/** MySQL SQL primitives shared by schema adaptation, introspection and rendering. */
import { createHash } from "node:crypto";

export function quoteMysqlIdentifier(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/** Runtime uses NO_BACKSLASH_ESCAPES so literals have one unambiguous encoding. */
export function quoteMysqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Integer display widths are not storage types; preserve unsigned / zerofill. */
export function normalizeMysqlType(type: string): string {
  // enum/set values are case-sensitive data, not type keywords.
  if (/^(enum|set)\(/i.test(type)) return type;
  return type.toLowerCase().replace(/\s*,\s*/g, ",")
    .replace(/\b(tinyint|smallint|mediumint|int|bigint)\(\d+\)/g, "$1")
    .replace(/^integer\b/, "int").replace(/\s+/g, " ").trim();
}

/** MySQL identifiers are limited to 64 characters; suffix keeps long names distinct. */
export function mysqlName(name: string): string {
  return name.length <= 64 ? name : `${name.slice(0, 47)}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

/** Tokenize expressions without rewriting quoted data or identifier contents. */
export function normalizeMysqlCheck(expression: string): string {
  const tokens = expression.match(/'(?:''|[^'])*'|`(?:``|[^`])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|<>|!=|<=|>=|[^\s]/g) ?? [];
  // The server adds outer parentheses and charset introducers to CHECK literals.
  while (tokens[0] === "(" && tokens.at(-1) === ")") {
    let depth = 0;
    const wraps = tokens.every((t, i) => {
      if (t === "(") depth++;
      if (t === ")") depth--;
      return depth > 0 || i === tokens.length - 1;
    });
    if (!wraps) break;
    tokens.shift(); tokens.pop();
  }
  return tokens.filter((t, i) => !/^_(utf8mb4|utf8mb3|utf8|latin1|ascii|binary)$/i.test(t) || !tokens[i + 1]?.startsWith("'"))
    .map((t) => t.startsWith("'") ? t : t.startsWith("`") ? t.slice(1, -1).replaceAll("``", "`").toLowerCase() : t.toLowerCase())
    .join(" ");
}
