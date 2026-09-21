export type CatalogRow = Record<string, unknown>;
export const stringValue = (value: unknown): string => String(value ?? "");
export function groupRows(
  rows: ReadonlyArray<CatalogRow>,
  key: string,
): Map<string, Array<CatalogRow>> {
  const groups = new Map<string, Array<CatalogRow>>();
  for (const row of rows) {
    const name = stringValue(row[key]);
    const group = groups.get(name) ?? [];
    group.push(row);
    groups.set(name, group);
  }
  return groups;
}

/** Conservative formatting normalization; never rewrite the content of string literals. */
export function normalizeServerExpression(expression: string): string {
  const tokens =
    expression.match(
      /N?'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:\]\]|[^\]])*\]|[A-Za-z_$][\w$#]*|\d+(?:\.\d+)?|<>|!=|<=|>=|[^\s]/g,
    ) ?? [];
  const normalized = tokens.map((token) =>
    token.startsWith("'") || token.startsWith("N'")
      ? token.replace(/^N'/, "'")
      : token.startsWith('"')
        ? token.slice(1, -1).replaceAll('""', '"')
        : token.startsWith("[")
          ? token.slice(1, -1).replaceAll("]]", "]").toUpperCase()
          : token.toUpperCase(),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < normalized.length - 2; i++) {
      if (
        normalized[i] === "(" &&
        normalized[i + 2] === ")" &&
        normalized[i + 1] !== "(" &&
        normalized[i + 1] !== ")" &&
        normalized[i - 1] !== "IN"
      ) {
        normalized.splice(i, 3, normalized[i + 1]!);
        changed = true;
      }
    }
    if (normalized[0] === "(" && normalized.at(-1) === ")") {
      let depth = 0;
      if (
        normalized.every((t, i) => {
          if (t === "(") depth++;
          if (t === ")") depth--;
          return depth > 0 || i === normalized.length - 1;
        })
      ) {
        normalized.shift();
        normalized.pop();
        changed = true;
      }
    }
  }
  return normalized.join(" ");
}
