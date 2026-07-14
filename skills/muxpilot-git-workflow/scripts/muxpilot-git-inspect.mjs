#!/usr/bin/env node
import { configuration, git } from "./local-workflow.mjs";

if (!process.argv[2]) {
  process.stderr.write("Usage: muxpilot-git-inspect <local-ref-or-commit>\n");
  process.exit(2);
}
try {
  const config = await configuration();
  const requested = process.argv[2];
  const sha = await git(config.repoRoot, ["rev-parse", "--verify", `${requested}^{commit}`]);
  process.stdout.write(`INSPECTION requested=${JSON.stringify(requested)} sha=${sha} freshness=local\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
