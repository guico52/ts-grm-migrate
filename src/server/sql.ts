import { createHash } from "node:crypto";
export type ServerDialect = "mssql" | "oracle";

/** Names and namespaces are shared by introspection, history and DDL rendering. */
export class ServerSql {
  constructor(
    readonly dialect: ServerDialect,
    readonly schema: string,
  ) {}
  identifier(name: string): string {
    return this.dialect === "mssql"
      ? `[${name.replaceAll("]", "]]")}]`
      : `"${name.replaceAll('"', '""')}"`;
  }
  table(name: string): string {
    return `${this.identifier(this.schema)}.${this.identifier(name)}`;
  }
  param(index: number): string {
    return this.dialect === "mssql" ? `@p${index}` : `:${index}`;
  }
  literal(value: string): string {
    return `${this.dialect === "mssql" ? "N" : ""}'${value.replaceAll("'", "''")}'`;
  }
  name(value: string): string {
    if (Buffer.byteLength(value) <= 128) return value;
    let prefix = value;
    while (Buffer.byteLength(prefix) > 100) prefix = prefix.slice(0, -1);
    return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
  }
}

export function normalizeServerType(
  type: string,
  dialect: ServerDialect,
): string {
  let result = type
    .toLowerCase()
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ");
  if (dialect === "mssql")
    result = result
      .replace(/^numeric\(/, "decimal(")
      .replace(/^float\(53\)$/, "float")
      .replace(/^datetime2\(7\)$/, "datetime2");
  else
    result = result
      .replace(/^timestamp\(6\)$/, "timestamp")
      .replace(/^(number\(\d+),0\)$/, "$1)");
  return result;
}
