import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
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
  assert(!listing.some(p => /(?:^|\/)(?:\.env|tests|node_modules|\.git)(?:\/|$)/.test(p)));
  const app = path.join(dir, 'consumer');
  await mkdir(app);
  await writeFile(path.join(app, 'package.json'), JSON.stringify({
    private: true, type: 'module', dependencies: {
      'ts-grm-migrate': `file:${archive}`, '@ts-grm/core': version, '@ts-grm/sql': version,
      'better-sqlite3': '13.0.3',
    },
  }));
  console.log(run('npm', ['install', '--omit=optional', '--no-audit', '--no-fund'], app));
  await writeFile(path.join(app, 'model.ts'), `import { model, prop } from '@ts-grm/core';\nexport const ITEM = model('Item', 'id', class { id = prop.i32(); name = prop.str(80); });\n`);
  await writeFile(path.join(app, 'ts-grm-migrate.config.ts'), `import { defineConfig } from 'ts-grm-migrate';\nexport default defineConfig({ dialect: 'sqlite', database: { file: './app.db' }, models: ['./model.ts'], migrationsDir: './migrations' });\n`);
  const bin = path.join(app, 'node_modules/.bin/tgm');
  assert.match(run(process.execPath, [bin, '--help'], app), /deploy/);
  assert.match(run(process.execPath, [bin, 'dev', '-n', 'init'], app), /已生成并应用迁移/);
  const status = run(process.execPath, [bin, 'status'], app);
  assert.match(status, /init/);
  assert(!run(process.execPath, [bin, 'dev'], app).includes('已生成并应用迁移'));
  run(process.execPath, [bin, 'deploy'], app);
  run(process.execPath, ['--input-type=module', '-e', `import { defineConfig } from 'ts-grm-migrate'; if (typeof defineConfig !== 'function') process.exit(1);`], app);
  await writeFile(path.join(app, 'consumer.mts'), `import { defineConfig, type Schema } from 'ts-grm-migrate';\nconst schema: Schema = { tables: [] };\ndefineConfig({dialect:'sqlite',database:{file:':memory:'},models:[]});\nconsole.log(schema);\n`);
  run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts'], app);
  const installed = JSON.parse(await readFile(path.join(app, 'node_modules/ts-grm-migrate/package.json'), 'utf8'));
  assert.equal(installed.license, 'MIT');
  console.log(`PASS: clean tarball install, ESM/types, native TypeScript config/model, linked CLI and SQLite migration with ts-grm ${version}`);
} finally { await rm(dir, { recursive: true, force: true }); }
