---
name: muxpilot-git-workflow
description: Run isolated local Git tasks in short-lived worktrees, self-review them, perform focused validation, and atomically integrate them into an existing local target branch.
---

# Muxpilot Local Git Workflow

Muxpilot supplies a repository entry path and an initial existing local target branch. The application observes this workflow but never creates worktrees, reviews changes, integrates commits, pulls, or pushes. User intent takes priority over these workflow rules through the guard-specific confirmation process below.

## Read-only work

For plans, answers, diagnosis, or review, inspect the repository entry path directly. Read applicable `AGENTS.md`, `CLAUDE.md`, and repository documentation before acting. Do not create a task worktree merely to inspect code.

## Change tasks

1. Tell the user you are creating an isolated task worktree, then run `node "$MUXPILOT_GIT_HELPER_DIR/muxpilot-git-begin.mjs"`.
2. Perform every repository write in the returned worktree. Shared dependency directories may be linked there and their real targets are writable for test caches.
3. Before changing dependency manifests, lockfiles, or installed packages, run `node "$MUXPILOT_GIT_HELPER_DIR/muxpilot-git-deps.mjs" localize <relative-dependency-path>` and install into the worktree-local directory.
4. Follow repository guidance, but default to focused file/module lint, typechecking, and tests. Run repository-wide suites only when the user requests them.
5. Make clean, logically atomic commits. Do not leave tracked or untracked task changes uncommitted.
6. Review the complete target-to-task diff yourself. Fix every actionable finding, rerun affected focused checks, commit fixes, and review again. Repeat until a final review finds nothing actionable. Any material change invalidates the prior review.
7. Run `node "$MUXPILOT_GIT_HELPER_DIR/muxpilot-git-finish.mjs"`. If the target advanced, the helper rebases and stops; rerun affected focused checks and the complete self-review loop before retrying. Resolve conflicts in the task worktree, then do the same.
8. Report completion only after the helper prints `INTEGRATED`. Successful integration removes the worktree and temporary branch. Failed or unfinished work is preserved.

Integration is entirely local. Normal helpers never create a target branch, pull, push, publish, or reconcile a remote. Multiple tasks may target the same branch; their short final integration steps serialize, and completion order determines landing order.

## Changing the target branch

Treat `muxpilot-git-status.mjs` as authoritative for the current target. The launch-time target is only the fallback before workflow status exists.

Changing the target is a `fixed-target` guard bypass. A user request naming another branch is not itself confirmation. Name the `fixed-target` guard, explain that current and future task commits will integrate into the new branch, and obtain separate explicit confirmation. Then run `node "$MUXPILOT_GIT_HELPER_DIR/muxpilot-git-target.mjs" <existing-local-branch> --bypass=fixed-target`.

The helper never creates or fetches a branch. If a task worktree exists, it is preserved and finalization rebases it onto the new target when necessary. Any active-worktree retarget invalidates prior validation and review; rerun focused checks and the complete self-review loop before integration, even when Git does not need to rebase.

## Guard-specific overrides

Muxpilot guards are: `worktree-isolation`, `same-agent-review`, `focused-validation`, `atomic-commits`, `clean-target`, `fixed-target`, `local-target-only`, `automatic-cleanup`, and `no-pull-push`.

When a user instruction conflicts with one or more guards:

1. Name each conflicting guard and explain the concrete consequence of bypassing it.
2. Obtain explicit confirmation for those exact guards before acting. Do not infer confirmation from the original conflicting request.
3. Scope confirmation to that operation only; every unrelated guard remains active.
4. Pass an exact `--bypass=<guard>` option when a helper supports the confirmed exception. There is no blanket force option.

Platform safety, sandbox, permission, and approval requirements are not muxpilot guards and cannot be bypassed through this process.
