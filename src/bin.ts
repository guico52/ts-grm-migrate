#!/usr/bin/env node
import { type CliLanguage, messages } from './cli/messages.js';
import { parseArgs, run } from './cli.js';
import { formatError } from './diagnostics/error.js';
import { MigrationAbortedError } from './migrator.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let language: CliLanguage = parseArgs(argv).flags.get('lang') === 'zh-CN' ? 'zh-CN' : 'en';
  try {
    process.exitCode = await run(argv, process.cwd(), {
      onLanguage: (selected) => {
        language = selected;
      },
    });
  } catch (e) {
    const m = messages(language);
    if (e instanceof MigrationAbortedError) {
      console.log(m.cancelled);
      process.exitCode = 0;
      return;
    }
    console.error(`${m.error}: ${formatError(e, language, parseArgs(argv).flags.has('detail'))}`);
    process.exitCode = 1;
  }
}

// 可执行入口与库导出分离，避免 config 与 import 形成循环。
void main();
