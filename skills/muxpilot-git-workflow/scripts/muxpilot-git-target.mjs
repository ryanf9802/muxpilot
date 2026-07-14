#!/usr/bin/env node
import { acquireWorkspaceLock, configuration, git, readStatus, worktreeExists, writeStatus } from "./local-workflow.mjs";

const bypasses = process.argv.slice(2)
  .filter((value) => value.startsWith("--bypass="))
  .map((value) => value.slice(9));
const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const unknownOptions = process.argv.slice(2).filter((value) => value.startsWith("--") && !value.startsWith("--bypass="));

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-target <existing-local-branch> --bypass=fixed-target\n");
  process.exit(0);
}
if (unknownOptions.length > 0 || bypasses.length !== 1 || bypasses[0] !== "fixed-target") {
  process.stderr.write("Changing the target branch requires the exact --bypass=fixed-target guard bypass.\n");
  process.exit(2);
}
if (positional.length !== 1) {
  process.stderr.write("Usage: muxpilot-git-target <existing-local-branch> --bypass=fixed-target\n");
  process.exit(2);
}

let releaseWorkspace = null;
try {
  releaseWorkspace = await acquireWorkspaceLock();
  const config = await configuration();
  const status = await readStatus(config);
  if (status?.state === "integrating") throw new Error("Cannot change the target branch during integration");

  const targetBranch = positional[0];
  await git(config.repoRoot, ["check-ref-format", "--branch", targetBranch]);
  await git(config.repoRoot, ["show-ref", "--verify", `refs/heads/${targetBranch}`]);
  const targetSha = await git(config.repoRoot, ["rev-parse", `refs/heads/${targetBranch}^{commit}`]);
  if (targetBranch === config.targetBranch) {
    await releaseWorkspace();
    releaseWorkspace = null;
    process.stdout.write(`TARGET_UNCHANGED target=refs/heads/${targetBranch} sha=${targetSha}\n`);
    process.exit(0);
  }

  const activeWorktree = Boolean(
    status?.sessionBranch
    && status.worktreePath
    && await worktreeExists(status.worktreePath)
  );
  await writeStatus(
    { ...config, targetBranch },
    activeWorktree
      ? {
          ...status,
          state: "worktree",
          targetSha,
          lastError: null,
          reviewRequired: true
        }
      : {
          state: "idle",
          targetSha,
          sessionBranch: null,
          worktreePath: null,
          lastError: null,
          reviewRequired: false
        }
  );
  await releaseWorkspace();
  releaseWorkspace = null;
  process.stdout.write(
    `TARGET_UPDATED previous=refs/heads/${config.targetBranch} target=refs/heads/${targetBranch} sha=${targetSha} review=${activeWorktree ? "required" : "not-required"}\n`
  );
} catch (error) {
  if (releaseWorkspace) await releaseWorkspace().catch(() => undefined);
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
