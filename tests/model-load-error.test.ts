import { describe, expect, it } from 'vitest';
import { modelLoadError } from '../src/model-load-error.js';
import { formatError } from '../src/diagnostics/error.js';

describe('model loading diagnostics', () => {
  const namingError = new Error(
    '[Illegal model "sys_user"]: Must follow PascalCase naming convention:\n                "^[a-z][A-Za-z\\d]*$"',
  );

  it('explains the actual naming rule in Chinese without English prose', () => {
    const error = modelLoadError(namingError);
    const message = formatError(error, 'zh-CN');
    expect(message).toContain('加载模型失败');
    expect(message).toContain('模型名称 "sys_user" 无效');
    expect(message).toContain('大写字母开头');
    expect(message).toContain('SysUser');
    expect(message).not.toMatch(/Illegal model|Must follow|Hint:|ESM/);
    expect(error.cause).toBe(namingError);
    expect(formatError(error, 'zh-CN', true)).toContain(namingError.message);
  });

  it('keeps English diagnostics for English output', () => {
    expect(formatError(modelLoadError(namingError), 'en')).toContain('Hint: Model names');
  });

  it.each([
    'Cannot use import statement outside a module',
    "Unexpected token 'export'",
    'exports is not defined in ES module scope',
  ])('localizes the module failure and ESM hint: %s', (message) => {
    const output = formatError(modelLoadError(new SyntaxError(message)), 'zh-CN');
    expect(output).toContain('提示：迁移工具通过 Node 原生 import');
    expect(output).not.toContain(message);
  });

  it.each([
    "Cannot find module '/missing.js'",
    'Illegal path "./missing.js" which does not exists',
  ])('localizes missing-file failures and preserves paths: %s', (message) => {
    const output = formatError(modelLoadError(new Error(message)), 'zh-CN');
    expect(output).toContain('missing.js');
    expect(output).toContain('请检查 models 路径');
    expect(output).not.toContain('ESM');
    expect(output).not.toContain(message);
  });

  it('keeps unknown upstream prose in explicit diagnostics', () => {
    const error = modelLoadError(new Error('invalid association'));
    expect(formatError(error, 'zh-CN')).toContain('外部组件返回了错误');
    expect(formatError(error, 'zh-CN')).not.toContain('invalid association');
    expect(formatError(error, 'zh-CN', true)).toContain('invalid association');
  });

  it('handles non-Error throws', () => {
    expect(modelLoadError('model factory failed').message).toBe(
      'Failed to load models: model factory failed',
    );
  });
});
