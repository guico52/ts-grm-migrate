import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { type SeedConfig, validateSeedConfig } from './config.js';
import { asError, diagnostic } from './diagnostics/error.js';

/** 运行用户自己的 seed 进程，不创建迁移 runtime。
 * 连接、事务和幂等性由脚本自己负责；输出直接继承终端。
 */
export async function runSeed(
  seed: SeedConfig,
  cwd: string,
  args: ReadonlyArray<string> = [],
): Promise<number> {
  validateSeedConfig(seed);
  const root = path.resolve(cwd);
  // 与包管理器的查找规则一致：优先项目本地的可执行文件，再逐级向上查找。
  const bins: string[] = [];
  for (let dir = root; ; dir = path.dirname(dir)) {
    bins.push(path.join(dir, 'node_modules', '.bin'));
    if (path.dirname(dir) === dir) break;
  }
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [...bins, env[pathKey] ?? ''].join(path.delimiter);

  return new Promise<number>((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(seed.command, [...(seed.args ?? []), ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: false,
      // POSIX 进程组让中断信号也能到达包装脚本及其子进程。
      detached: grouped,
    });
    let interrupted: NodeJS.Signals | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (grouped) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    };
    const forward = (signal: 'SIGINT' | 'SIGTERM'): void => {
      if (interrupted) {
        terminate('SIGKILL');
        return;
      }
      interrupted = signal;
      terminate(signal);
      escalation = setTimeout(() => terminate('SIGKILL'), 5_000);
      escalation.unref();
    };
    const onInterrupt = (): void => forward('SIGINT');
    const onTerminate = (): void => forward('SIGTERM');
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (escalation) clearTimeout(escalation);
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    child.once('error', (error) => {
      cleanup();
      reject(diagnostic('seed_start', seed.command, asError(error)));
    });
    child.once('close', (code, signal) => {
      // 包装进程可能先于忽略了转发信号的子孙进程退出。
      if (interrupted && grouped) terminate('SIGKILL');
      cleanup();
      const termination = interrupted ?? signal;
      resolve(termination ? 128 + (constants.signals[termination] ?? 1) : (code ?? 1));
    });
  });
}
