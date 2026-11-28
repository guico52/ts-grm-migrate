import picomatch from 'picomatch';
import { asError, diagnostic } from './diagnostics/error.js';

/** 字符串为完整物理表名 glob；RegExp 遵循 JavaScript 匹配语义。 */
export type TablePattern = string | RegExp;
export type TableMatcher = (table: string) => boolean;

/** 每次操作编译一次，不读取或修改调用方 RegExp 的 lastIndex。 */
export function createTableMatcher(patterns: unknown): TableMatcher {
  if (patterns === undefined) return () => false;
  if (!Array.isArray(patterns)) throw diagnostic('exclude_config');
  const matchers = patterns.map((pattern): TableMatcher => {
    if (pattern instanceof RegExp) {
      if (pattern.global || pattern.sticky)
        throw diagnostic('exclude_regex_flags', pattern.toString());
      const regex = new RegExp(pattern.source, pattern.flags);
      return (table) => regex.test(table);
    }
    if (typeof pattern !== 'string' || pattern.trim() === '' || pattern.includes('\0'))
      throw diagnostic('exclude_config');
    if (pattern.startsWith('!')) throw diagnostic('exclude_glob_negation', pattern);
    // 无 glob 符号时保留精确匹配，避免把合法标识符中的括号等当成正则语法。
    if (!/[\\*?[{]/.test(pattern)) return (table) => table === pattern;
    try {
      // @see https://github.com/micromatch/picomatch#options
      const regex = picomatch.makeRe(escapeGlobOperators(pattern), {
        dot: true,
        windows: false,
        nonegate: true,
        noextglob: true,
        noglobstar: true,
        strictBrackets: true,
        strictSlashes: true,
        literalBrackets: false,
        regex: false,
        debug: true,
      });
      return (table) => regex.exec(table)?.[0] === table;
    } catch (error) {
      throw diagnostic('exclude_glob', pattern, asError(error));
    }
  });
  return (table) => matchers.some((match) => match(table));
}

/** 字符串只使用 glob 语法，括号和竖线在字符集合外按字面量处理。 */
function escapeGlobOperators(pattern: string): string {
  let output = '';
  let escaped = false;
  let inClass = false;
  for (const char of pattern) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\') escaped = true;
    else if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass && (char === '(' || char === ')' || char === '|')) output += '\\';
    output += char;
  }
  return output;
}
