import { defineConfig } from 'tsdown';

// 与 ts-grm 使用同一构建工具。peer 依赖保持 external，确保模型注册到宿主的同一个 ESM 实例。
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  deps: {
    neverBundle: [/^@ts-grm\//, 'pg', 'mysql2/promise', 'better-sqlite3', 'mssql', 'oracledb'],
  },
});
