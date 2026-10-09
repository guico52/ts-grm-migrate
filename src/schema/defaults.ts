import type { DialectName } from '../dialect.js';

/** Compare catalog forms conservatively: casts inside expressions retain their semantics. */
export function sameDefault(
  left: string,
  right: string | undefined,
  type: string,
  dialect: DialectName,
): boolean {
  if (right === undefined) return false;
  const a = canonical(left, type, dialect);
  const b = canonical(right, type, dialect);
  if (a === b) return true;
  if (
    !/^(?:smallint|int(?:eger)?|bigint|tinyint|mediumint|numeric|decimal|number|real|float|double|money|bit)\b/i.test(
      type,
    )
  )
    return false;
  const na = numeric(a);
  const nb = numeric(b);
  return na !== undefined && na === nb;
}

const TOKEN =
  /'(?:''|[^'])*'|"(?:""|[^"])*"|::|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[^\s]/g;

function canonical(value: string, type: string, dialect: DialectName): string {
  let tokens: string[] = value.match(TOKEN) ?? [];
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
  if (dialect === 'mssql' && /^[nN]$/.test(tokens[0] ?? '') && tokens[1]?.startsWith("'"))
    tokens.shift();
  if (dialect === 'postgres') {
    const cast = tokens.indexOf('::');
    const literal = tokens.slice(0, cast).join('');
    if (
      cast >= 0 &&
      /^(?:'(?:''|[^'])*'|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false)$/i.test(literal)
    ) {
      const castType = tokens
        .slice(cast + 1)
        .join(' ')
        .toLowerCase()
        .replace(/\s*([(),])\s*/g, '$1');
      const columnType = type.toLowerCase().replace(/\s*([(),])\s*/g, '$1');
      const unboundedText =
        /^(?:text|character varying|varchar)$/.test(castType) &&
        /^(?:text|character varying|varchar)\b/.test(columnType);
      if (castType === columnType || unboundedText) tokens = tokens.slice(0, cast);
    }
  }
  return tokens
    .map((t) => (t.startsWith("'") || t.startsWith('"') ? t : t.toLowerCase()))
    .join(' ')
    .replace(/^([+-]) /, '$1');
}

/** Decimal coefficient/exponent representation, without floating point or expanded exponents. */
function numeric(value: string): string | undefined {
  const raw = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(raw);
  if (!match) return undefined;
  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  if (digits === '') return '0';
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  const exponent = BigInt(match[4] ?? '0') - BigInt(match[3]?.length ?? 0) + BigInt(trailing);
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}
