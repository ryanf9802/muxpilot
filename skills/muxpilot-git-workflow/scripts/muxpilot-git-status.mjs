#!/usr/bin/env node
import { configuration, git, readStatus } from "./local-workflow.mjs";

try {
  const config = await configuration();
  const status = await readStatus(config);
  const targetSha = await git(config.repoRoot, ["rev-parse", `refs/heads/${config.targetBranch}^{commit}`]);
  process.stdout.write(`${JSON.stringify(status ?? { version: 1, state: "idle", targetBranch: config.targetBranch, targetSha }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
