import { diagnostic } from '../diagnostics/error.js';
import type { DialectName } from '../dialect.js';

/** SQL tokens retain quoted contents; comments never participate in comparison. */
export function sqlTokens(sql: string, dialect?: DialectName): string[] {
  const brackets = dialect === 'postgres' ? '' : String.raw`\[(?:\]\]|[^\]])*\]|`;
  const pattern = new RegExp(
    brackets +
      String.raw`'(?:''|[^'])*'|"(?:""|[^"])*"|\x60(?:\x60\x60|[^\x60])*\x60|--[^\n]*|\/\*[\s\S]*?\*\/|::|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]`,
    'g',
  );
  return (sql.match(pattern) ?? []).filter((t) => !t.startsWith('--') && !t.startsWith('/*'));
}

function unwrap(tokens: string[]): string[] {
  while (tokens[0] === '(' && tokens.at(-1) === ')') {
    let depth = 0;
    if (
      !tokens.every((t, i) => {
        if (t === '(') depth++;
        if (t === ')') depth--;
        return depth > 0 || i === tokens.length - 1;
      })
    )
      break;
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

function identifier(token: string, dialect: DialectName): string {
  if (token.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"');
  return dialect === 'postgres' ? token.toLowerCase() : token;
}

/** Only normalize proven literal membership forms, never arbitrary casts or expressions. */
export function checkKey(
  expression: string,
  dialect: DialectName,
  types: ReadonlyMap<string, string>,
): string {
  const tokens = unwrap(sqlTokens(expression, dialect));
  const split = tokens.findIndex((t) => /^(?:in|=)$/i.test(t));
  if (split > 0) {
    let lhs = unwrap(tokens.slice(0, split));
    const cast = lhs.lastIndexOf('::');
    const column = unwrap(cast < 0 ? lhs : lhs.slice(0, cast));
    if (
      cast >= 0 &&
      lhs
        .slice(cast + 1)
        .join('')
        .toLowerCase() === 'text' &&
      column.length === 1 &&
      /^(?:text|varchar|character varying)\b/.test(types.get(identifier(column[0]!, dialect)) ?? '')
    )
      lhs = column;
    let rhs = tokens.slice(split + 1);
    if (tokens[split]?.toLowerCase() === 'in') rhs = unwrap(rhs);
    else {
      if (rhs[0]?.toLowerCase() !== 'any') rhs = unwrap(rhs);
      else {
        rhs = unwrap(rhs.slice(1));
        const arrayCast = rhs.lastIndexOf('::');
        if (
          arrayCast >= 0 &&
          rhs
            .slice(arrayCast + 1)
            .join('')
            .toLowerCase() === 'text[]' &&
          /^(?:text|varchar|character varying)\b/.test(
            types.get(identifier(lhs[0] ?? '', dialect)) ?? '',
          )
        )
          rhs = unwrap(rhs.slice(0, arrayCast));
        if (rhs[0]?.toLowerCase() === 'array' && rhs[1] === '[' && rhs.at(-1) === ']')
          rhs = rhs.slice(2, -1);
        else rhs = [];
      }
    }
    if (lhs.length === 1 && /^(?:"(?:""|[^"])+"|[A-Za-z_$][\w$]*)$/.test(lhs[0]!) && rhs.length) {
      const values: string[] = [];
      let valid = true;
      const parts: string[][] = [[]];
      for (const token of rhs) {
        if (token === ',') parts.push([]);
        else parts.at(-1)!.push(token);
      }
      for (const part of parts) {
        const value = unwrap(part);
        if (
          value[1] === '::' &&
          /^(?:text|varchar|character varying)$/.test(value.slice(2).join(' ').toLowerCase()) &&
          value[0]?.startsWith("'") &&
          /^(?:text|varchar|character varying)\b/.test(
            types.get(identifier(lhs[0]!, dialect)) ?? '',
          )
        )
          value.splice(1);
        const literal = value.join('');
        if (!/^(?:'(?:''|[^'])*'|[+-]?\d+(?:\.\d+)?|true|false)$/i.test(literal)) {
          valid = false;
          break;
        }
        values.push(literal);
      }
      if (valid) return JSON.stringify(['membership', identifier(lhs[0]!, dialect), values]);
    }
  }
  return JSON.stringify(
    tokens.map((t) =>
      t.startsWith("'")
        ? t
        : t.startsWith('"')
          ? `id:${identifier(t, dialect)}`
          : /^[A-Za-z_$][\w$]*$/.test(t)
            ? /^(?:and|or|not|in|is|null|true|false|any|array|case|when|then|else|end|collate)$/i.test(
                t,
              )
              ? `keyword:${t.toLowerCase()}`
              : `id:${identifier(t, dialect)}`
            : t,
    ),
  );
}

/** Extract CHECK bodies with balanced tokens, including nested expressions and quoted delimiters. */
export function sqliteChecks(sql: string): string[] {
  const tokens = sqlTokens(sql),
    result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.toLowerCase() !== 'check' || tokens[i + 1] !== '(') continue;
    let depth = 1,
      end = i + 2;
    for (; end < tokens.length && depth; end++) {
      if (tokens[end] === '(') depth++;
      if (tokens[end] === ')') depth--;
    }
    if (depth) throw diagnostic('sqlite_check_parse');
    result.push(tokens.slice(i + 2, end - 1).join(' '));
    i = end - 1;
  }
  return result;
}
