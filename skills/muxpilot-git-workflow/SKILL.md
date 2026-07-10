---
name: muxpilot-git-workflow
description: Complete changes in muxpilot-managed Git worktrees, including atomic commits, independent review fixes, automatic target integration, and cross-branch inspection. Use whenever a Codex session has MUXPILOT_GIT_WORKSPACE_ID or a muxpilot-managed target branch.
---

# Muxpilot Git Workflow

Use the current directory and private session branch as the default implementation environment. These workflow constraints are guardrails, not hard rules: an explicit user instruction may override the specific location or Git operation it names. Keep every unrelated guardrail in effect, and do not infer an exception from a general implementation request. Normal approval, safety, and destructive-action requirements still apply.

1. Read the target branch, private session branch, and worktree path from the launch instructions.
2. By default, keep edits and task commits on the private session branch without switching branches or moving target refs. Follow an explicit user request to work in another checkout or perform a normally restricted Git operation only to the extent requested.
3. Inspect current state with `git status --short --branch` and compare committed work with the target SHA.
4. Test the requested changes, create small atomic commits, and leave the worktree clean.
5. By default, use only inspection worktrees or exact revisions provisioned by muxpilot when comparing other branches. Request another revision with `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-inspect.mjs" <remote/branch>` and record the returned SHA.
6. When the task still uses muxpilot-managed integration, run `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-finish.mjs"` before reporting completion. Skip it when an explicit user exception makes that integration path inapplicable.
7. If it reports `CHANGES_REQUESTED`, fix every finding, test, commit the fixes, and run it again. If it reports a rebase conflict, resolve it in this worktree, continue the rebase, and retry.
8. When using managed integration, report completion only after the helper reports `INTEGRATED`. Muxpilot then replaces this worktree generation at the same path for future tasks.

By default, do not run `git push`, check out or update the target branch, delete worktrees, delete muxpilot refs, or integrate directly. Remote push normally remains a user-only UI action. The user may explicitly request any of these operations; honor only the requested exception and preserve the remaining guardrails.
