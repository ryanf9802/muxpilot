---
name: muxpilot-git-workflow
description: Complete changes in muxpilot-managed Git worktrees, including atomic commits, independent review fixes, automatic target integration, and cross-branch inspection. Use whenever a Codex session has MUXPILOT_GIT_WORKSPACE_ID or a muxpilot-managed target branch.
---

# Muxpilot Git Workflow

Use the current directory and private session branch as the default place for agent-authored changes. The worktree is a coordination tool, not a boundary on what the agent may inspect or do. User intent controls task scope; never ignore or misreport another checkout because it is outside the session worktree. Normal approval, safety, and destructive-action requirements still apply.

1. Read the target branch, private session branch, and worktree path from the launch instructions.
2. By default, make new implementation changes and task commits on the private session branch. When the user names another branch, checkout, or Git operation, locate the relevant checkout and follow that request there; no special override wording is required.
3. Inspect every checkout relevant to the request before describing its branch, index, tracked files, or untracked files. Never use the session worktree's state to claim that another checkout is clean or dirty.
4. Test the requested changes, create small atomic commits, and leave the worktree clean.
5. By default, use inspection worktrees or exact revisions provisioned by muxpilot when comparing committed branch contents. Request another revision with `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-inspect.mjs" <remote/branch>` and record the returned SHA. Inspect the actual checkout directly for working-copy state or checkout-specific actions.
6. When the task uses muxpilot-managed integration, run `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-finish.mjs"` before reporting completion. Skip it for work performed exclusively outside that integration path; for mixed tasks, finalize the managed portion separately.
7. If it reports `CHANGES_REQUESTED`, fix every finding, test, commit the fixes, and run it again. If it reports a rebase conflict, resolve it in this worktree, continue the rebase, and retry.
8. When using managed integration, report completion only after the helper reports `INTEGRATED`. Muxpilot then replaces this worktree generation at the same path for future tasks.

If a requested write falls outside the sandbox's writable roots, use the normal approval or escalation path instead of refusing it as out of scope. Ask for confirmation when a request is ambiguous, destructive, unusually risky, or apparently irrational—not merely because it affects another checkout. An instruction naming a checkout or operation authorizes only that requested scope; preserve unrelated guardrails.
