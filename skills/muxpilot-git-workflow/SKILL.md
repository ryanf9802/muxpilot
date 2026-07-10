---
name: muxpilot-git-workflow
description: Complete changes in muxpilot-managed Git worktrees, including atomic commits, independent review fixes, automatic target integration, and cross-branch inspection. Use whenever a Codex session has MUXPILOT_GIT_WORKSPACE_ID or a muxpilot-managed target branch.
---

# Muxpilot Git Workflow

Treat the current directory and branch as the only editable implementation environment.

1. Read the target branch, private session branch, and worktree path from the launch instructions.
2. Keep all edits and task commits on the private session branch. Do not switch branches or move target refs.
3. Inspect current state with `git status --short --branch` and compare committed work with the target SHA.
4. Test the requested changes, create small atomic commits, and leave the worktree clean.
5. Use only inspection worktrees or exact revisions provisioned by muxpilot when comparing other branches. Request another revision with `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-inspect.mjs" <remote/branch>` and record the returned SHA.
6. Before reporting completion, run `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-finish.mjs"`.
7. If it reports `CHANGES_REQUESTED`, fix every finding, test, commit the fixes, and run it again. If it reports a rebase conflict, resolve it in this worktree, continue the rebase, and retry.
8. Report completion only after it reports `INTEGRATED`. Muxpilot then replaces this worktree generation at the same path for future tasks.

Never run `git push`, check out the target branch, delete worktrees, delete muxpilot refs, or integrate directly. Remote push remains a user-only UI action.
