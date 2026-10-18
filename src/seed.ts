import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { validateSeedConfig, type SeedConfig } from './config.js';
import { asError, diagnostic } from './diagnostics/error.js';

/** Run a user-owned seed process without creating a migration runtime.
 * The script owns its connections, transactions and idempotency. Output is inherited.
 */
export async function runSeed(
  seed: SeedConfig,
  cwd: string,
  args: ReadonlyArray<string> = [],
): Promise<number> {
  validateSeedConfig(seed);
  const root = path.resolve(cwd);
  // Match package-manager lookup: project-local binaries take precedence, then ancestors.
  const bins: string[] = [];
  for (let dir = root; ; dir = path.dirname(dir)) {
    bins.push(path.join(dir, 'node_modules', '.bin'));
    if (path.dirname(dir) === dir) break;
  }
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [...bins, env[pathKey] ?? ''].join(path.delimiter);

  return new Promise<number>((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(seed.command, [...(seed.args ?? []), ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: false,
      // POSIX process groups let interruption reach wrappers and their children too.
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
    child.once('error', error => {
      cleanup();
      reject(diagnostic('seed_start', seed.command, asError(error)));
    });
    child.once('close', (code, signal) => {
      // A wrapper may exit before descendants that ignored the forwarded signal.
      if (interrupted && grouped) terminate('SIGKILL');
      cleanup();
      const termination = interrupted ?? signal;
      resolve(termination ? 128 + (constants.signals[termination] ?? 1) : code ?? 1);
    });
  });
}
