import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelLoadError } from '../src/model-load-error';
import { loadModelFiles, modelImportUrl } from '../src/model-loader';

describe('模型导入 URL', () => {
  it.each([
    ['F:\\project\\src\\model.ts', 'file:///F:/project/src/model.ts'],
    [
      'F:\\project #1\\中文\\model?.mts',
      'file:///F:/project%20%231/%E4%B8%AD%E6%96%87/model%3F.mts',
    ],
    ['\\\\server\\share\\model%data.mjs', 'file://server/share/model%25data.mjs'],
  ])('Windows 路径 %s 转为 ESM 可用 URL', (file, url) => {
    expect(modelImportUrl(file, true)).toBe(url);
  });
  it('POSIX 路径保留 #、%、? 和空格，不作为 URL 片段或查询参数', () => {
    expect(modelImportUrl('/tmp/app # % ?/model.ts', false)).toBe(
      'file:///tmp/app%20%23%20%25%20%3F/model.ts',
    );
  });
});

const distIndex = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const nativeExec = promisify(execFile);

describe.skipIf(!existsSync(distIndex))('模型文件加载（原生 Node ESM）', () => {
  let dir: string;
  let key: symbol;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tgm models # % 中文 '));
    key = Symbol.for(dir);
    await mkdir(path.join(dir, 'models/nested'), { recursive: true });
  });
  afterEach(async () => {
    Reflect.deleteProperty(globalThis, key);
    await rm(dir, { recursive: true, force: true });
  });
  const source = (name: string) =>
    `const key = Symbol.for(${JSON.stringify(name)}); globalThis[key] = (globalThis[key] ?? 0) + 1;`;
  const modelSource = () =>
    `import { model, prop } from ${JSON.stringify(import.meta.resolve('@ts-grm/core'))}; model('WindowsImportedModel', 'id', class { id = prop.i64(); });`;
  async function nativeLoad(models: string[]): Promise<number> {
    await writeFile(
      path.join(dir, 'config.mjs'),
      `export default ${JSON.stringify({ dialect: 'sqlite', database: { file: ':memory:' }, models, migrationsDir: './migrations', lockPath: './lock' })}`,
    );
    const script = `import { run } from ${JSON.stringify(modelImportUrl(distIndex))};
      await run(['dev','--create-only','--config','./config.mjs'], ${JSON.stringify(dir)}, {log:()=>{}});
      console.log(globalThis[Symbol.for(${JSON.stringify(dir)})]);`;
    const { stdout } = await nativeExec(process.execPath, ['--input-type=module', '-e', script]);
    return Number(stdout.trim());
  }

  it('递归导入 ts/mts/js/mjs，跳过声明及其他文件，重叠目录不会重复注册', async () => {
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
    for (const file of ['a.ts', 'b.mts', 'nested/c.js', 'nested/d.mjs']) {
      await writeFile(path.join(dir, 'models', file), source(dir));
    }
    await writeFile(path.join(dir, 'models/a.d.ts'), 'throw new Error("declaration imported")');
    await writeFile(path.join(dir, 'models/b.d.mts'), 'throw new Error("declaration imported")');
    await writeFile(path.join(dir, 'models/notes.txt'), 'not JavaScript');
    await writeFile(path.join(dir, 'models/nested/model.mts'), modelSource());
    expect(await nativeLoad(['./models', './models/nested/d.mjs'])).toBe(4);
  });

  it('经 file URL 导入带 #、% 和空格的文件', async () => {
    await writeFile(path.join(dir, 'models/a # %.mjs'), source(dir) + modelSource());
    expect(await nativeLoad(['./models/a # %.mjs'])).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('目录符号链接循环不会重复遍历', async () => {
    await writeFile(path.join(dir, 'models/a.mjs'), source(dir) + modelSource());
    await symlink(path.join(dir, 'models'), path.join(dir, 'models/nested/cycle'), 'dir');
    expect(await nativeLoad(['./models'])).toBe(1);
  });

  it('无效相对路径及缺失文件给出可操作诊断', async () => {
    await expect(loadModelFiles(dir, ['models'])).rejects.toThrow(/start with/);
    const error = await loadModelFiles(dir, ['./missing.ts']).catch((error: unknown) => error);
    expect(modelLoadError(error).message).toContain('Check models paths');
  });
});
