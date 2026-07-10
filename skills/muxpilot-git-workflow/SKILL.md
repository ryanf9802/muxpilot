---
name: muxpilot-git-workflow
description: Create short-lived implementation worktrees for muxpilot-managed Git changes, including atomic commits, independent review fixes, automatic target integration, cleanup, and exact cross-branch inspection. Use whenever a Codex session has MUXPILOT_GIT_WORKSPACE_ID or a muxpilot-managed target branch.
---

# Muxpilot Git Workflow

Muxpilot Git chats start in a neutral control directory with no implementation checkout. Read-only work must stay worktree-free. Create a short-lived worktree only for a change/build task, use it for all managed writes, and finalize it before reporting completion. The worktree is a coordination tool, not a boundary on what the agent may inspect or do. User intent controls task scope; never ignore or misreport another checkout because it is outside the implementation worktree. Normal approval, safety, and destructive-action requirements still apply.

1. Read the repository entry path and target branch from the launch instructions. Before repository work, read applicable repository instructions from the entry path because the current directory is only a control directory.
2. For answers, plans, reviews, diagnosis, and other read-only tasks, inspect the named checkout directly and do not create an implementation worktree.
3. For a change/build task, tell the user that this skill is creating the implementation checkout, then run `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-begin.mjs"`. Record the returned branch and path and make every managed repository write there.
4. When the user names another branch, checkout, or Git operation, locate the relevant checkout and follow that request there; no special override wording is required. Inspect every relevant checkout before describing its working-copy state.
5. Test the requested changes, create small atomic commits, and leave the implementation worktree clean.
6. When comparing committed branch contents, request an exact revision with `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-inspect.mjs" <remote/branch>` and record the returned ref and SHA. This does not create a checkout. Inspect the actual checkout directly for working-copy state or checkout-specific actions.
7. When the task uses muxpilot-managed integration, run `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-finish.mjs"` before reporting completion. Successful integration removes the implementation worktree. Skip it for work performed exclusively outside that integration path; for mixed tasks, finalize the managed portion separately.
8. If it reports `CHANGES_REQUESTED`, fix every finding, test, commit the fixes, and run it again. Findings cannot be bypassed. If it reports a rebase conflict, resolve it in the implementation worktree, continue the rebase, and retry.
9. If it reports `REVIEW_INCOMPLETE`, stop and tell the user that independent review did not complete, including the reported reason. Ask whether integration should proceed without successful review. Do not integrate or report completion unless the user explicitly approves.
10. After explicit user approval of an incomplete review, run `node "$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-finish.mjs" --integrate-without-review`. Never use this flag preemptively or after `CHANGES_REQUESTED`.
11. When using managed integration, report completion only after the helper reports `INTEGRATED`, and state whether review passed or was bypassed. The next change task will create a fresh generation from the latest managed target.

If a requested write falls outside the sandbox's writable roots, use the normal approval or escalation path instead of refusing it as out of scope. Ask for confirmation when a request is ambiguous, destructive, unusually risky, or apparently irrational—not merely because it affects another checkout. An instruction naming a checkout or operation authorizes only that requested scope; preserve unrelated guardrails.
