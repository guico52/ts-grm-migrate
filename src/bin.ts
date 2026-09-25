#!/usr/bin/env node
import { parseArgs, run } from "./cli.js";
import { messages, type CliLanguage } from "./cli/messages.js";
import { MigrationAbortedError } from "./migrator.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let language: CliLanguage = parseArgs(argv).flags.get("lang") === "zh-CN" ? "zh-CN" : "en";
  try {
    process.exitCode = await run(argv, process.cwd(), { onLanguage: (selected) => { language = selected; } });
  } catch (e) {
    const m = messages(language);
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
