import { stat } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { diagnostic } from './diagnostics/error.js';

export interface ProcessLock {
  readonly path: string;
  release(): Promise<void>;
}

/** Atomic directory acquisition and renewable leases avoid partially written PID files.
 * A crashed holder is reclaimable after 10 seconds. Never manually remove a live lease.
 * @see https://github.com/moxystudio/node-proper-lockfile#design
 */
export async function acquireProcessLock(lockPath: string): Promise<ProcessLock> {
  const resolved = path.resolve(lockPath);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(resolved, {
      realpath: false,
      lockfilePath: resolved,
      stale: 10_000,
      update: 2_000,
      retries: 0,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
      throw diagnostic('lock_busy', resolved);
    throw error;
  }
  const owner = await stat(resolved);
  let released = false;
  return {
    path: resolved,
    async release() {
      if (released) return;
      released = true;
      const current = await stat(resolved).catch(() => undefined);
      if (
        !current ||
        current.ino !== owner.ino ||
        current.dev !== owner.dev ||
        current.birthtimeMs !== owner.birthtimeMs
      )
        throw diagnostic('lock_lost', resolved);
      await release();
    },
  };
}
