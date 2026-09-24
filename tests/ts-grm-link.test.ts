import { describe, it, expect } from "vitest";
import { newSqlClient } from "../src/vendor/ts-grm";

/** 验证安装的 npm peer 经适配层可用；历史版本矩阵见 scripts/test-compatibility.mjs。 */
describe("ts-grm 引用", () => {
  it("适配层可解析且导出可调用", () => {
    expect(typeof newSqlClient).toBe("function");
  });
});
