import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = process.argv[2] ?? '0.0.13';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a ts-grm version');
const dir = await mkdtemp(path.join(tmpdir(), 'tgm-package-'));
function run(command, args, cwd = dir) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
try {
  const archive = path.join(dir, 'migrate.tgz');
  console.log(run('corepack', ['yarn', 'pack', '--out', archive], root));
  const listing = run('tar', ['-tzf', archive]).trim().split('\n');
  assert(listing.includes('package/LICENSE'));
  assert(listing.includes('package/THIRD_PARTY_NOTICES.md'));
  assert(listing.includes('package/LICENSES/Apache-2.0.txt'));
  assert(listing.includes('package/dist/bin.mjs'));
  assert(!listing.some((p) => /(?:^|\/)(?:\.env|tests|node_modules|\.git)(?:\/|$)/.test(p)));
  const app = path.join(dir, 'consumer');
  await mkdir(app);
  await writeFile(
    path.join(app, 'package.json'),
    JSON.stringify({
      name: '@tgm-fixture/backend',
      private: true,
      type: 'module',
      devDependencies: {
        'ts-grm-migrate': `file:${archive}`,
      },
      dependencies: {
        '@ts-grm/core': version,
        '@ts-grm/sql': version,
        'better-sqlite3': '13.0.3',
      },
    }),
  );
  console.log(run('npm', ['install', '--omit=optional', '--no-audit', '--no-fund'], app));
  await writeFile(
    path.join(app, 'model.ts'),
    `import { model, prop } from '@ts-grm/core';\nexport const ITEM = model('Item', 'id', class { id = prop.i32(); name = prop.str(80); });\n`,
  );
  await writeFile(
    path.join(app, 'ts-grm-migrate.config.ts'),
    `import { defineConfig } from 'ts-grm-migrate';\nexport default defineConfig({ dialect: 'sqlite', database: { file: './app.db' }, models: ['./model.ts'], migrationsDir: './migrations', seed: { command: process.execPath, args: ['./seed.mts'] } });\n`,
  );
  const bin = path.join(app, 'node_modules/.bin/tgm');
  assert.match(run(process.execPath, [bin, '--help'], app), /deploy/);
  assert.match(run('npx', ['--offline', '--no-install', 'tgm', '--help'], app), /--create-only/);
  assert.match(
    run(process.execPath, [bin, 'dev', '-n', 'init'], app),
    /Generated and applied migration/,
  );
  await writeFile(
    path.join(app, 'seed.mts'),
    `import { writeFileSync } from 'node:fs';\nconst args: string[] = process.argv.slice(2);\nwriteFileSync('seed-result.json', JSON.stringify(args));\n`,
  );
  assert.match(
    run(process.execPath, [bin, 'seed', '--', '--environment', 'package test'], app),
    /Seed completed/,
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(app, 'seed-result.json'), 'utf8')), [
    '--environment',
    'package test',
  ]);
  const status = run(process.execPath, [bin, 'status'], app);
  assert.match(status, /init/);
  assert.match(run(process.execPath, [bin, 'dev'], app), /no migration needed/);
  run(process.execPath, [bin, 'deploy'], app);
  assert.match(run(process.execPath, [bin, 'check'], app), /matches the model/);
  if (version === '0.0.13') {
    run('npm', ['install', '--no-audit', '--no-fund', 'ts-grm-patches@0.1.0'], app);
    await writeFile(
      path.join(app, 'patched-model.ts'),
      `import { model, prop } from '@ts-grm/core';\nimport 'ts-grm-patches';\nexport const ITEM = model('PatchedItem', 'id', class { id = prop.i32().autoIncrement(); name = prop.str(80).default('01'); });\n`,
    );
    await writeFile(
      path.join(app, 'patched.config.mts'),
      `import { applyPatches } from 'ts-grm-patches';\napplyPatches();\nexport default { dialect: 'sqlite', database: { file: './patched.db' }, models: ['./patched-model.ts'], migrationsDir: './patched-migrations' };\n`,
    );
    assert.match(
      run(process.execPath, [bin, 'dev', '--create-only', '--config', 'patched.config.mts'], app),
      /Generated migration/,
    );
    assert.match(
      run(process.execPath, [bin, 'deploy', '--config', 'patched.config.mts'], app),
      /Applied 1 migration/,
    );
    assert.match(
      run(process.execPath, [bin, 'check', '--config', 'patched.config.mts'], app),
      /matches the model/,
    );
  }
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { defineConfig } from 'ts-grm-migrate'; if (typeof defineConfig !== 'function') process.exit(1);`,
    ],
    app,
  );
  await writeFile(
    path.join(app, 'consumer.mts'),
    `import { defineConfig, runSeed, type SeedConfig, type Schema } from 'ts-grm-migrate';\nconst schema: Schema = { tables: [] };\ndefineConfig({dialect:'sqlite',database:{file:':memory:'},models:[],seed:{command:'node',args:['seed.mts']}});\nconst seed: SeedConfig = {command:'node'};\nconst runner: (config: SeedConfig, cwd: string) => Promise<number> = runSeed;\nvoid seed; void runner;\nconsole.log(schema);\n`,
  );
  run(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.mts',
    ],
    app,
  );
  const installed = JSON.parse(
    await readFile(path.join(app, 'node_modules/ts-grm-migrate/package.json'), 'utf8'),
  );
  assert.equal(installed.license, 'MIT');
  // 模拟未提升依赖的 workspace：CLI 只存在于 consumer/node_modules 中。
  // npm 11.12.1 按包名而不是目录名推导 workspace 的 bin 路径。
  // @see https://github.com/npm/cli/blob/v11.12.1/lib/commands/exec.js
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['consumer'] }),
  );
  assert.match(
    run('npx', ['--offline', '--no-install', '--workspaces=false', 'tgm', '--help'], app),
    /--create-only/,
  );
  assert.match(
    run(
      'npx',
      ['--offline', '--no-install', '--workspaces=false', 'tgm', 'dev', '--create-only'],
      app,
    ),
    /no migration needed/,
  );
  // npm 风格的 workspace 中，根目录下按包名建立的链接让直接 npx 也能工作。
  await mkdir(path.join(dir, 'node_modules/@tgm-fixture'), { recursive: true });
  await symlink(app, path.join(dir, 'node_modules/@tgm-fixture/backend'), 'dir');
  assert.match(run('npx', ['--offline', '--no-install', 'tgm', '--help'], app), /--create-only/);
  console.log(
    `PASS: clean devDependency install, npx (standalone/workspace), ESM/types, native TypeScript config/model/seed and SQLite migration with ts-grm ${version}`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
