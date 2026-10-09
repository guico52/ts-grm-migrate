import { diagnostic, asError } from './diagnostics/error.js';

/** Add advice only when the upstream failure identifies an actionable cause. */
export function modelLoadError(error: unknown): Error {
  const original = error instanceof Error ? error.message : String(error);
  // Preserve thrown values as Error causes, rather than losing their diagnostic text.
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
  if (/Cannot find (?:module|package)|Illegal path .*which does not exists/.test(original)) {
    return diagnostic('model_missing', cause);
  }
  return diagnostic('model_load', cause);
}
