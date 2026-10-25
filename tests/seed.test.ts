import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/cli';
import { loadConfig } from '../src/config';
import { runSeed } from '../src/seed';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/bin.mjs', import.meta.url));
const sqlite = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'tgm seed '));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function config(seed?: unknown, language = 'en', name = 'ts-grm-migrate.config.mjs') {
  // Invalid connection and missing models prove that seed bypasses migration assembly.
  await writeFile(
    path.join(dir, name),
    `export default ${JSON.stringify({
      database: { host: 'unreachable.invalid', file: './must-not-exist.db' },
      models: ['./missing-models'],
      seed,
      language,
    })};`,
  );
}

async function script(source: string, name = 'seed script.mjs') {
  await writeFile(path.join(dir, name), source);
  await config({ command: process.execPath, args: [name] });
}

describe('seed configuration and argument boundary', () => {
  it.each([
    null,
    'node seed.ts',
    [],
    {},
    { command: '' },
    { command: '  ' },
    { command: 1 },
    { command: 'node', args: 'seed.ts' },
    { command: 'node', args: [1] },
    { command: 'node', args: ['a\0b'] },
    { command: 'a\0b' },
  ])('rejects invalid seed configuration %j', async (value) => {
    await config(value);
    await expect(loadConfig(dir)).rejects.toThrow(/Invalid seed configuration/);
  });

  it('keeps migration configuration without seed valid', async () => {
    await config();
    expect((await loadConfig(dir)).config.seed).toBeUndefined();
  });

  it('preserves every argument after -- without parsing CLI flags', () => {
    const parsed = parseArgs([
      'seed',
      '--lang',
      'zh-CN',
      '--',
      '--help',
      '--lang',
      'xx',
      '',
      'a b',
      '--',
    ]);
    expect(parsed.flags.get('lang')).toBe('zh-CN');
    expect(parsed.flags.has('help')).toBe(false);
    expect(parsed.passthrough).toEqual(['--help', '--lang', 'xx', '', 'a b', '--']);
    expect(parseArgs(['seed']).passthrough).toEqual([]);
  });

  it('reports missing seed without creating a database or loading models', async () => {
    await config(undefined, 'zh-CN');
    const errors: string[] = [];
    expect(await run(['seed'], dir, { errorLog: (m) => errors.push(m) })).toBe(1);
    expect(errors.join('')).toContain('未配置 seed');
    expect(await readdir(dir)).toEqual(['ts-grm-migrate.config.mjs']);
  });
});

describe('seed executable integration (build first)', () => {
  it('inherits env and cwd, preserves spaces/quotes/metacharacters, and honors --config', async () => {
    await mkdir(path.join(dir, 'config'));
    const args = [
      '--help',
      '--lang',
      'invalid',
      'a b',
      '',
      '"quoted"',
      "it's",
      '$(touch injected)',
      ';touch injected',
      '--',
    ];
    await script(`import { writeFileSync } from 'node:fs';
      writeFileSync('result.json', JSON.stringify({ cwd: process.cwd(), env: process.env.TGM_SEED_TEST, args: process.argv.slice(2) }));`);
    await config(
      { command: process.execPath, args: ['seed script.mjs', 'configured arg'] },
      'en',
      'config/custom.mjs',
    );
    const { stdout } = await exec(
      process.execPath,
      [cli, 'seed', '--config', 'config/custom.mjs', '--', ...args],
      {
        cwd: dir,
        env: { ...process.env, TGM_SEED_TEST: 'inherited value' },
      },
    );
    expect(JSON.parse(await readFile(path.join(dir, 'result.json'), 'utf8'))).toEqual({
      cwd: dir,
      env: 'inherited value',
      args: ['configured arg', ...args],
    });
    expect(stdout).toContain('Seed completed.');
    expect((await readdir(dir)).sort()).toEqual([
      'config',
      'result.json',
      'seed script.mjs',
      'ts-grm-migrate.config.mjs',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'finds local executables before the inherited PATH, including workspace ancestors',
    async () => {
      const bin = path.join(dir, 'node_modules/.bin');
      await mkdir(bin, { recursive: true });
      await writeFile(
        path.join(bin, 'tgm-fixture-seeder'),
        '#!/usr/bin/env node\nconsole.log("local-seed");\n',
      );
      await chmod(path.join(bin, 'tgm-fixture-seeder'), 0o755);
      const app = path.join(dir, 'packages/app');
      await mkdir(app, { recursive: true });
      await config({ command: 'tgm-fixture-seeder' });
      const { stdout } = await exec(
        process.execPath,
        [cli, 'seed', '--config', '../../ts-grm-migrate.config.mjs'],
        { cwd: app },
      );
      expect(stdout).toContain('local-seed');
    },
  );

  it('retains a script failure exit code, stdout and stderr without claiming success', async () => {
    await script(
      'console.log("before failure"); console.error("seed detail"); process.exitCode = 23;',
    );
    const failure = await exec(process.execPath, [cli, 'seed'], { cwd: dir }).catch(
      (error) => error,
    );
    expect(failure.code).toBe(23);
    expect(failure.stdout).toContain('before failure');
    expect(failure.stdout).not.toContain('Seed completed');
    expect(failure.stderr).toContain('seed detail');
    expect(failure.stderr).toContain('exit code 23');
  });

  it('inherits terminal input', async () => {
    await script(
      'process.stdin.setEncoding("utf8"); process.stdin.on("data", data => process.stdout.write(data));',
    );
    const child = spawn(process.execPath, [cli, 'seed'], { cwd: dir });
    let output = '';
    child.stdout.on('data', (data) => {
      output += String(data);
    });
    const closed = once(child, 'close');
    child.stdin.end('seed input\n');
    expect((await closed)[0]).toBe(0);
    expect(output).toContain('seed input');
  });

  it('localizes startup errors and supports --lang override', async () => {
    await config({ command: 'tgm-nonexistent-seed-executable' }, 'zh-CN');
    const failure = await exec(process.execPath, [cli, 'seed'], { cwd: dir }).catch(
      (error) => error,
    );
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('无法启动 seed');
    const override = await exec(process.execPath, [cli, 'seed', '--lang', 'en'], {
      cwd: dir,
    }).catch((error) => error);
    expect(override.stderr).toContain('Cannot start seed executable');
  });

  it('reports a missing configuration in both languages', async () => {
    await config(undefined, 'zh-CN');
    const failure = await exec(process.execPath, [cli, 'seed'], { cwd: dir }).catch(
      (error) => error,
    );
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('未配置 seed');
    const override = await exec(process.execPath, [cli, 'seed', '--lang', 'en'], {
      cwd: dir,
    }).catch((error) => error);
    expect(override.stderr).toContain('No seed configured');
  });

  it('runs native TypeScript and makes repeated SQLite initialization idempotent', async () => {
    await script(
      `import Database from ${JSON.stringify(sqlite)};
      const name: string = 'English';
      const db = new Database('seed.db');
      try {
        db.exec('create table if not exists language(code text primary key, name text not null)');
        db.prepare('insert into language values (?, ?) on conflict(code) do update set name=excluded.name').run('en', name);
      } finally { db.close(); }`,
      'seed.mts',
    );
    for (let i = 0; i < 2; i++) await exec(process.execPath, [cli, 'seed'], { cwd: dir });
    const db = new Database(path.join(dir, 'seed.db'));
    try {
      expect(db.prepare('select * from language').all()).toEqual([{ code: 'en', name: 'English' }]);
      expect(
        db.prepare("select name from sqlite_master where name like '%migration%'").all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not seed during migration commands', async () => {
    await script('throw new Error("SEED_MUST_NOT_RUN");');
    for (const command of ['dev', 'deploy', 'push']) {
      const failure = await exec(process.execPath, [cli, command], { cwd: dir }).catch(
        (error) => error,
      );
      expect(failure.code).toBe(1);
      expect(failure.stdout).not.toContain('Running seed');
      expect(failure.stderr).not.toContain('SEED_MUST_NOT_RUN');
    }
  });

  it('rejects migration-only options before running seed', async () => {
    await script('console.log("MUST_NOT_RUN");');
    for (const flag of [
      '--dry-run',
      '--create-only',
      '--force',
      '--name=init',
      '--environment=development',
    ]) {
      const failure = await exec(process.execPath, [cli, 'seed', flag], { cwd: dir }).catch(
        (error) => error,
      );
      expect(failure.code).toBe(1);
      expect(failure.stdout).not.toContain('MUST_NOT_RUN');
    }
  });

  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s and treats interruption as failure even if the script exits 0',
    async (signal) => {
      await script(`import { writeFileSync } from 'node:fs';
      process.on('${signal}', () => { writeFileSync('interrupted', '${signal}'); process.exit(0); });
      console.log('READY'); setInterval(() => {}, 1000);`);
      const child = spawn(process.execPath, [cli, 'seed'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const closed = once(child, 'close');
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('seed did not become ready')), 5_000);
          child.stdout.on('data', (data) => {
            output += String(data);
            if (output.includes('READY')) {
              clearTimeout(timeout);
              resolve();
            }
          });
        });
        child.kill(signal);
        expect((await closed)[0]).toBe(signal === 'SIGINT' ? 130 : 143);
        expect(await readFile(path.join(dir, 'interrupted'), 'utf8')).toBe(signal);
        expect(output).not.toContain('Seed completed');
      } finally {
        child.kill('SIGKILL');
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills an interrupted seed that ignores SIGTERM after the grace period',
    async () => {
      await script(
        'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);',
      );
      const child = spawn(process.execPath, [cli, 'seed'], { cwd: dir });
      const closed = once(child, 'close');
      let output = '';
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('seed did not become ready')), 5_000);
          child.stdout.on('data', (data) => {
            output += String(data);
            if (output.includes('READY')) {
              clearTimeout(timeout);
              resolve();
            }
          });
        });
        child.kill('SIGTERM');
        expect((await closed)[0]).toBe(143);
        expect(output).not.toContain('Seed completed');
      } finally {
        child.kill('SIGKILL');
      }
    },
  );
});

it('removes signal handlers after success and startup failure', async () => {
  const int = process.listenerCount('SIGINT');
  const term = process.listenerCount('SIGTERM');
  expect(await runSeed({ command: process.execPath, args: ['-e', ''] }, dir)).toBe(0);
  await expect(runSeed({ command: 'tgm-nonexistent-seed-executable' }, dir)).rejects.toThrow(
    /Cannot start seed/,
  );
  expect(process.listenerCount('SIGINT')).toBe(int);
  expect(process.listenerCount('SIGTERM')).toBe(term);
});
