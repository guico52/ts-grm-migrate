import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 含真实数据库的集成测试（*-postgres）要建 schema / 跑迁移，
    // 多套件并发时超过默认 5s 属于网络 + DDL 的固有开销，不是死循环
    testTimeout: 30_000,
    // hook 的超时是独立配置：`beforeAll` 里要 drop/create schema，
    // 默认 10s 会给成「整个套件被 skip」（表现为几条 ↓ 而不是 ×，很容易误读）
    hookTimeout: 30_000,
    // 集成套件各自持有连接池；并发运行时容易耗尽测试数据库的 max_connections，
    // 表现为随机超时。按文件串行执行更稳定。
    fileParallelism: false,
  },
});
