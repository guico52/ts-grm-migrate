import { describe, it, expect } from "vitest";
import { newSqlClient } from "../src/vendor/ts-grm";

/**
 * ts-grm 引用冒烟：验证 workspace 依赖真实可用（经 src/vendor 适配层）。
 * 依赖 ts-grm 已构建（packages 下的 dist 存在），见 README「依赖接入」一节。
 */
describe("ts-grm 引用", () => {
  it("适配层可解析且导出可调用", () => {
    expect(typeof newSqlClient).toBe("function");
  });
});
