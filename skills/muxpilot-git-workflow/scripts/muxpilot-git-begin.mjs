#!/usr/bin/env node

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-begin\n");
  process.exit(0);
}
if (process.argv.length > 2) {
  process.stderr.write(`Unknown argument: ${process.argv[2]}\n`);
  process.exit(2);
}

const baseUrl = process.env.MUXPILOT_GIT_HELPER_URL;
const workspaceId = process.env.MUXPILOT_GIT_WORKSPACE_ID;
const token = process.env.MUXPILOT_GIT_HELPER_TOKEN;
if (!baseUrl || !workspaceId || !token) {
  process.stderr.write("This command is only available inside a muxpilot-managed Git session.\n");
  process.exit(2);
}

const response = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/begin`, {
  method: "POST",
  headers: { "x-muxpilot-git-token": token }
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  process.stderr.write(`${payload.code ? `${payload.code}: ` : ""}${payload.error ?? `Begin failed with HTTP ${response.status}`}\n`);
  process.exit(1);
}
const workspace = payload.workspace;
if (!workspace?.worktreePath || !workspace?.sessionBranch) {
  process.stderr.write("Muxpilot did not return an implementation worktree.\n");
  process.exit(1);
}
const status = workspace.lastError ? "WORKTREE_RECOVERY_CONFLICT" : "WORKTREE_READY";
process.stdout.write(`${status} ${workspace.worktreePath} branch=${workspace.sessionBranch} generation=${workspace.generation}\n`);
if (workspace.lastError) process.stdout.write(`${workspace.lastError}\nResolve the recovered changes in this worktree before finalizing.\n`);
