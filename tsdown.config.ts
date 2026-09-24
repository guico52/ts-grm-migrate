import { defineConfig } from 'tsdown';

// Same build tool as ts-grm. Keep peers external so model registration uses the host's ESM instance.
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  deps: { neverBundle: [/^@ts-grm\//, 'pg', 'mysql2/promise', 'better-sqlite3', 'mssql', 'oracledb'] },
});
