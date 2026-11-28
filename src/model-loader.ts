import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnostic } from './diagnostics/error.js';

/** 盘符、UNC 路径和 #/?/% 等字符必须交给 Node 转成 file URL。 */
export function modelImportUrl(file: string, windows?: boolean): string {
  // @see https://nodejs.org/api/url.html#urlpathtofileurlpath-options
  return pathToFileURL(file, { windows }).href;
}

/** 仅触发 ESM 模型注册；保留上游递归加载目录和进程级模型注册表的行为。 */
export async function loadModelFiles(cwd: string, models: ReadonlyArray<string>): Promise<void> {
  const visited = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    const absolute = await realpath(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) await visit(path.join(absolute, entry));
    } else if (info.isFile() && /\.(?:m?ts|m?js)$/.test(absolute) && !/\.d\.m?ts$/.test(absolute)) {
      await import(modelImportUrl(absolute));
    }
  };
  for (const relative of models) {
    if (!/^\.{1,2}[/\\]/.test(relative)) throw diagnostic('model_relative_path', relative);
    await visit(path.resolve(cwd, relative));
  }
}
