import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireProcessLock } from '../src/lock';

describe('atomic process leases', () => {
  let dir: string, lockPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tgm-lock-'));
    lockPath = path.join(dir, 'lock');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('acquires an atomic directory and releases idempotently', async () => {
    const lock = await acquireProcessLock(lockPath);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
    await expect(acquireProcessLock(lockPath)).rejects.toThrow(/lock is held/);
    await lock.release();
    await lock.release();
    await expect(stat(lockPath)).rejects.toThrow();
  });
  it('does not steal a fresh lease before metadata is written', async () => {
    await mkdir(lockPath);
    await expect(acquireProcessLock(lockPath)).rejects.toThrow(/lock is held/);
  });
  it('reclaims an expired crashed lease', async () => {
    await mkdir(lockPath);
    const old = new Date(Date.now() - 20_000);
    await utimes(lockPath, old, old);
    const lock = await acquireProcessLock(lockPath);
    await lock.release();
  });
  it('admits only one concurrent owner', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireProcessLock(lockPath)),
    );
    const owners = results.filter((r) => r.status === 'fulfilled');
    expect(owners).toHaveLength(1);
    for (const owner of owners) if (owner.status === 'fulfilled') await owner.value.release();
  });
});
