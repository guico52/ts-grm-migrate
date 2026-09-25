/**
 * CLI 的公共类型（单独放一处，避免 cli.ts ↔ 各命令模块循环依赖）。
 */
import type { Diff } from "../diff/types.js";
import type { CliLanguage } from "./messages.js";

/** `parseArgs` 结果 */
export interface ParsedArgs {
  /** 第一个位置参数（命令名） */
  readonly command: string | undefined;
  /** `--key value` / `--key=value` / `-h` 形式的选项 */
  readonly flags: ReadonlyMap<string, string | true>;
}

/** `run()` 的可注入依赖（测试用） */
export interface RunOptions {
  /** 覆盖破坏性变更的确认逻辑 */
  readonly confirm?: (diff: Diff) => Promise<boolean>;
  readonly log?: (message: string) => void;
  readonly errorLog?: (message: string) => void;
  /** Receive the active language, including a default read from the project config. */
  readonly onLanguage?: (language: CliLanguage) => void;
}
