#!/usr/bin/env node
import { run } from "./cli.js";
import { MigrationAbortedError } from "./migrator.js";

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2), process.cwd());
  } catch (e) {
    if (e instanceof MigrationAbortedError) {
      console.log("已取消。");
      process.exitCode = 0;
      return;
    }
    console.error(`错误：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// Keep the executable separate from library exports; no config/import cycle.
void main();
