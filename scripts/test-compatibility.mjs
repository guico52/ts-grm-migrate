// Isolated historical dependency checks; never rewrites the working tree or lockfile.
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const versions = process.argv.slice(2);
if (!versions.length || versions.some(v => !/^\d+\.\d+\.\d+$/.test(v))) {
  throw new Error('Usage: node scripts/test-compatibility.mjs 0.0.12 0.0.13');
}
const scratch = await mkdtemp(path.join(tmpdir(), 'tgm-compat-'));
const results = [];
const env = { ...process.env };
if (env.COMPAT_DATABASES !== '1') {
  for (const name of ['PG_HOST', 'MYSQL_HOST', 'MSSQL_HOST', 'ORACLE_HOST']) delete env[name];
}
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { passed: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}` };
}
try {
  for (const version of versions) {
    const cwd = path.join(scratch, version);
    await mkdir(cwd);
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    const install = run('npm', ['install', '--ignore-scripts', '--omit=optional', '--legacy-peer-deps', '--no-audit', '--no-fund', `@ts-grm/core@${version}`, `@ts-grm/sql@${version}`], cwd);
    if (!install.passed) {
      console.error(`${version}: dependency installation failed\n${install.output}`);
      results.push({ version, install });
      continue;
    }
    // npm may install a different nested core for historical SQL releases. Record that fact.
    const sql = JSON.parse(await readFile(path.join(cwd, 'node_modules/@ts-grm/sql/package.json'), 'utf8'));
    for (const entry of await readdir(path.join(root, 'node_modules'))) {
      if (entry === '@ts-grm' || entry === '.package-lock.json') continue;
      try { await symlink(path.join(root, 'node_modules', entry), path.join(cwd, 'node_modules', entry), 'dir'); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    for (const entry of ['src', 'tests', 'tsconfig.json', 'vitest.config.ts']) {
      await cp(path.join(root, entry), path.join(cwd, entry), { recursive: true });
    }
    const types = run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], cwd);
    const tests = run(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--exclude', 'tests/manual-postgres.test.ts'], cwd);
    results.push({ version, sqlCoreDependency: sql.dependencies?.['@ts-grm/core'], types, tests });
    console.log(`${version}: types=${types.passed ? 'PASS' : 'FAIL'} tests=${tests.passed ? 'PASS' : 'FAIL'}`);
    console.log(tests.output.split('\n').filter(line => /Test Files|Tests\s/.test(line)).join('\n'));
    if (!types.passed) console.error(types.output);
    if (!tests.passed) console.error(tests.output.slice(-16000));
  }
  const output = process.env.COMPAT_REPORT ?? path.join(tmpdir(), `tgm-compatibility-${process.pid}.json`);
  await writeFile(output, JSON.stringify({ node: process.version, results }, null, 2));
  console.log(`Report: ${output}`);
  if (results.some(r => !r.types?.passed || !r.tests?.passed)) process.exitCode = 1;
} finally { await rm(scratch, { recursive: true, force: true }); }
