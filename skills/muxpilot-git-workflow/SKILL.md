---
name: muxpilot-git-workflow
description: Follow muxpilot's isolated Git worktree workflow for implementation, commits, cross-branch inspection, conflict resolution, review handoff, and integration readiness. Use whenever a Codex session is launched with a muxpilot-managed target branch or MUXPILOT_GIT_WORKSPACE_ID.
---

# Muxpilot Git Workflow

Treat the current directory and branch as the only editable implementation environment.

1. Read the target branch, private session branch, and worktree path from the launch instructions.
2. Keep all edits and task commits on the private session branch. Do not switch branches or move target refs.
3. Inspect current state with `git status --short --branch` and compare committed work with `git diff <target-sha>..HEAD`.
4. Create small, atomic commits with messages that describe one logical change. Leave the worktree clean when the task is ready.
5. Use only inspection worktrees or exact revisions provisioned by muxpilot when comparing other branches. Request another revision with `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-inspect.mjs" <remote/branch>` and record the returned SHA.
6. If muxpilot places the worktree in a rebase conflict, resolve only those conflicts, test the result, and continue the rebase. Do not merge the target branch.
7. Stop after committing and testing. Let the muxpilot Git panel run review, integration, push, and cleanup.

Never run `git push`, check out the target branch, delete worktrees, delete muxpilot refs, or integrate directly. If an unprovisioned remote revision is needed, ask muxpilot to add an inspection instead of changing the implementation checkout.
