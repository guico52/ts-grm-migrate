import { asError, DiagnosticError, diagnostic } from './diagnostics/error.js';

/** 只有当上游错误能指出可操作的原因时才附加建议。 */
export function modelLoadError(error: unknown): Error {
  if (error instanceof DiagnosticError) return error;
  const original = error instanceof Error ? error.message : String(error);
  // 把抛出的值保留为 Error 的 cause，避免丢失诊断信息。
  const cause = asError(error);
  if (/^\[Illegal model "[^"]+"\]: Must follow PascalCase naming convention:/.test(original)) {
    return diagnostic('model_naming', cause);
  }
  if (
    /Cannot use import statement outside a module|Unexpected token ['"]?export|\b(exports|module|require) is not defined in ES module scope\b/.test(
      original,
    )
  ) {
    return diagnostic('model_module', cause);
  }
  if (
    /Cannot find (?:module|package)|Illegal path .*which does not exists/.test(original) ||
    (error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
  ) {
    return diagnostic('model_missing', cause);
  }
  return diagnostic('model_load', cause);
}
