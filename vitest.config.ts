import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 含真实数据库的集成测试（*-postgres）要建 schema / 跑迁移，
    // 多套件并发时超过默认 5s 属于网络 + DDL 的固有开销，不是死循环
    testTimeout: 30_000,
    // hook 的超时是独立配置：`beforeAll` 里要 drop/create schema，
    // 默认 10s 会给成「整个套件被 skip」（表现为几条 ↓ 而不是 ×，很容易误读）
    hookTimeout: 30_000,
    // 测试库与其他应用共用（实测 ~54 个 JDBC 连接常驻，max_connections=100），
    // 并发跑多个 PG 集成套件会挤爆剩余配额，表现为随机超时。串行更稳。
    fileParallelism: false,
  },
});
