#!/usr/bin/env node
import { configuration, localizeDependency, readStatus, worktreeExists } from "./local-workflow.mjs";

if (process.argv[2] !== "localize" || !process.argv[3]) {
  process.stderr.write("Usage: muxpilot-git-deps localize <relative-path>\n");
  process.exit(2);
}
try {
  const config = await configuration();
  const status = await readStatus(config);
  if (status?.state !== "worktree" || !(await worktreeExists(status.worktreePath))) throw new Error("No active task worktree");
  const path = await localizeDependency(config, status.worktreePath, process.argv[3]);
  process.stdout.write(`DEPENDENCY_LOCALIZED ${path}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
