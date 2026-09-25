#!/usr/bin/env node
import { parseArgs, run } from "./cli.js";
import { messages } from "./cli/messages.js";
import { MigrationAbortedError } from "./migrator.js";

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2), process.cwd());
  } catch (e) {
    const m = messages(parseArgs(process.argv.slice(2)).flags.get("lang") === "zh-CN" ? "zh-CN" : "en");
    if (e instanceof MigrationAbortedError) {
      console.log(m.cancelled);
      process.exitCode = 0;
      return;
    }
    console.error(`${m.error}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// Keep the executable separate from library exports; no config/import cycle.
void main();
