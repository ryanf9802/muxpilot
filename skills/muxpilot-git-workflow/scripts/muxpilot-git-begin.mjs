#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { configuration, git, ignoreSharedDependencies, linkDependencies, readStatus, worktreeExists, writeStatus } from "./local-workflow.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-begin\n");
  process.exit(0);
}

try {
  const config = configuration();
  const existing = await readStatus(config);
  if (["worktree", "blocked", "failed"].includes(existing?.state) && await worktreeExists(existing.worktreePath)) {
    process.stdout.write(`WORKTREE_READY ${existing.worktreePath} branch=${existing.sessionBranch} reused=true\n`);
    process.exit(0);
  }
  await git(config.repoRoot, ["show-ref", "--verify", `refs/heads/${config.targetBranch}`]);
  const targetSha = await git(config.repoRoot, ["rev-parse", `refs/heads/${config.targetBranch}^{commit}`]);
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const branch = `muxpilot/${config.workspaceId}/${suffix}`;
  const worktreePath = join(config.worktreeRoot, suffix);
  await git(config.repoRoot, ["worktree", "add", "-b", branch, worktreePath, targetSha]);
  const links = await linkDependencies(config, worktreePath);
  await ignoreSharedDependencies(config, worktreePath);
  await writeStatus(config, { state: "worktree", targetSha, sessionBranch: branch, worktreePath });
  process.stdout.write(`WORKTREE_READY ${worktreePath} branch=${branch}\n`);
  for (const link of links) process.stdout.write(`DEPENDENCY_REUSED kind=${link.kind} path=${link.relativePath} source=${link.sourcePath}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
