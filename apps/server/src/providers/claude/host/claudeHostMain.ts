import { parseHostArguments, runClaudeHost } from "./claudeHost.js";

runClaudeHost(parseHostArguments(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`claude host failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
