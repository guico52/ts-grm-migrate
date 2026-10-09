import type { OutputLanguage } from '../config.js';
import { diagnostics, type DiagnosticKey } from './catalog.js';

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Keep structured parameters and causes until the output language is selected. */
export class DiagnosticError extends Error {
  constructor(
    readonly key: DiagnosticKey,
    readonly values: ReadonlyArray<unknown>,
  ) {
    super(render(diagnostics[key].en, values, 'en', new Set()), {
      cause: values.find((value) => value instanceof Error),
    });
    this.name = 'DiagnosticError';
  }
}

export function diagnostic(key: DiagnosticKey, ...values: ReadonlyArray<unknown>): DiagnosticError {
  return new DiagnosticError(key, values);
}

export class DiagnosticAggregateError extends AggregateError {
  constructor(
    errors: ReadonlyArray<unknown>,
    readonly key: DiagnosticKey,
    readonly values: ReadonlyArray<unknown>,
  ) {
    super(errors, render(diagnostics[key].en, values, 'en', new Set()));
  }
}

function render(
  template: string,
  values: ReadonlyArray<unknown>,
  language: OutputLanguage,
  seen: Set<unknown>,
): string {
  return template.replace(/\{(\d+)\}/g, (_, index: string) => {
    const value = values[Number(index)];
    return value instanceof Error ? describe(value, language, seen) : String(value);
  });
}

function describe(error: unknown, language: OutputLanguage, seen: Set<unknown>): string {
  if (seen.has(error))
    return language === 'zh-CN' ? '错误原因包含循环引用' : 'Circular error cause';
  seen.add(error);
  try {
    if (error instanceof DiagnosticError || error instanceof DiagnosticAggregateError)
      return render(diagnostics[error.key][language], error.values, language, seen);
    if (language === 'en') return error instanceof Error ? error.message : String(error);
    if (error instanceof AggregateError) {
      return error.errors.map((cause: unknown) => describe(cause, language, seen)).join('；');
    }
    return describeExternal(error);
  } finally {
    seen.delete(error);
  }
}

function describeExternal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Upstream validates PascalCase, but 0.0.13 incorrectly prints the property-name regex.
  // @see https://github.com/babyfish-ct/ts-grm/blob/fe78eb6c323bf335ff23650a414856eb36bfbce7/packages/core/src/impl/entity.ts
  const model = message.match(
    /^\[Illegal model "([^"]+)"\]: Must follow PascalCase naming convention:/,
  );
  if (model)
    return `模型名称 "${model[1]}" 无效：必须以大写字母开头，且只能包含字母和数字（PascalCase，例如 SysUser）。`;
  const missing =
    message.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/) ??
    message.match(/Illegal path "([^"]+)" which does not exists/);
  if (missing) return `找不到文件或依赖 "${missing[1]}"。`;
  const illegalPath = message.match(/Illegal path "([^"]+)", it must be relative path/);
  if (illegalPath)
    return `模型路径 "${illegalPath[1]}" 无效：必须使用以 ./ 或 ../ 开头的相对路径。`;
  if (/Cannot use import statement outside a module|Unexpected token ['"]?export/.test(message))
    return '模块格式不匹配：当前文件无法使用 ESM 的 import 或 export。';
  const commonjs = message.match(/\b(exports|module|require) is not defined in ES module scope\b/);
  if (commonjs) return `ESM 文件中不能直接使用 CommonJS 的 ${commonjs[1]}。`;
  if (/Duplicate models with same name:/.test(message)) {
    const name = message.match(/"([^"]+)"/);
    return `存在同名模型${name ? ` "${name[1]}"` : ''}，请使用不同的模型名称。`;
  }
  const fields =
    error != null && typeof error === 'object'
      ? (error as { code?: unknown; path?: unknown; number?: unknown; errorNum?: unknown; constraint?: unknown; table?: unknown; column?: unknown })
      : {};
  const code =
    typeof fields.code === 'string' || typeof fields.code === 'number' ? String(fields.code) : '';
  const descriptions: Record<string, string> = {
    ENOENT: '文件或目录不存在',
    EACCES: '没有访问权限',
    EPERM: '操作权限不足',
    EEXIST: '文件已存在',
    ECONNREFUSED: '数据库连接被拒绝',
    ECONNRESET: '连接被重置',
    ETIMEDOUT: '连接超时',
    ENOTFOUND: '无法解析主机名',
    SQLITE_ERROR: 'SQL 执行失败',
    SQLITE_CANTOPEN: '无法打开 SQLite 数据库',
    SQLITE_BUSY: 'SQLite 数据库正被占用',
    SQLITE_CONSTRAINT_UNIQUE: '违反唯一性约束',
    SQLITE_CONSTRAINT_PRIMARYKEY: '违反主键约束',
    SQLITE_CONSTRAINT_FOREIGNKEY: '违反外键约束',
    SQLITE_CONSTRAINT_NOTNULL: '违反非空约束',
    '23505': '违反唯一性约束',
    '23503': '违反外键约束',
    '23502': '违反非空约束',
    '42601': 'SQL 语法错误',
    '42P01': '数据库表不存在',
    '42703': '数据库列不存在',
    '28P01': '数据库身份验证失败',
    ER_DUP_ENTRY: '违反唯一性约束',
    ER_PARSE_ERROR: 'SQL 语法错误',
    ER_ACCESS_DENIED_ERROR: '数据库身份验证失败',
    ELOGIN: '数据库身份验证失败',
  };
  // SQL Server and Oracle also expose numeric database error codes.
  const serverDescriptions: Record<number, string> = {
    2601: '违反唯一性约束', 2627: '违反唯一性约束', 515: '违反非空约束', 547: '违反外键或检查约束',
  };
  const oracleDescriptions: Record<number, string> = {
    1: '违反唯一性约束', 1400: '违反非空约束', 2291: '违反外键约束', 2292: '删除操作违反外键约束', 1017: '数据库身份验证失败',
  };
  const number = typeof fields.number === 'number' ? fields.number : undefined;
  const errorNum = typeof fields.errorNum === 'number' ? fields.errorNum : undefined;
  const description = descriptions[code] ?? (number !== undefined ? serverDescriptions[number] : undefined) ?? (errorNum !== undefined ? oracleDescriptions[errorNum] : undefined) ?? '外部组件返回了错误';
  const codes = [code, number, errorNum].filter((value) => value !== undefined && value !== '').join(' / ');
  const context = [
    ['路径', fields.path], ['表', fields.table], ['列', fields.column], ['约束', fields.constraint],
  ].filter(([, value]) => typeof value === 'string').map(([label, value]) => `${label} ${value}`).join('，');
  return `${description}${codes ? `（错误码 ${codes}）` : ''}${context ? `：${context}` : ''}。请使用 --detail 查看原始诊断。`;
}

/** Unknown third-party prose is kept in explicit diagnostics, not mixed into Chinese output. */
export function formatError(error: unknown, language: OutputLanguage, detail = false): string {
  const message = describe(error, language, new Set());
  if (!detail || language === 'en') return message;
  const raw = rawDiagnostics(error, new Set());
  return raw.length ? `${message}\n原始诊断：\n${raw.join('\n')}` : message;
}

function rawDiagnostics(error: unknown, seen: Set<unknown>): Array<string> {
  if (seen.has(error)) return [];
  seen.add(error);
  if (!(error instanceof Error)) return [String(error)];
  const lines = error instanceof DiagnosticError || error instanceof DiagnosticAggregateError ? [] : [error.message];
  if (error.cause !== undefined) lines.push(...rawDiagnostics(error.cause, seen));
  if (error instanceof AggregateError)
    for (const cause of error.errors) lines.push(...rawDiagnostics(cause, seen));
  if (error instanceof DiagnosticError)
    for (const value of error.values)
      if (value instanceof Error) lines.push(...rawDiagnostics(value, seen));
  return lines;
}
