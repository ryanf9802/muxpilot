---
name: muxpilot-git-workflow
description: Run isolated local Git tasks in short-lived worktrees, self-review them, perform focused validation, and atomically integrate them into an existing local target branch.
---

# Muxpilot Local Git Workflow

Managed muxpilot sessions supply a repository entry path and an initial existing local target branch. Direct Codex sessions running in tmux can initialize the standalone mode below. The application observes workflow events but never creates worktrees, reviews changes, integrates commits, pulls, or pushes. User intent takes priority over these workflow rules through the guard-specific authorization process below.

## Read-only work

For plans, answers, diagnosis, or review, inspect the repository entry path directly. Read applicable `AGENTS.md`, `CLAUDE.md`, and repository documentation before acting. Do not create a task worktree merely to inspect code.

## Change tasks

Resolve `<helper-dir>` from `MUXPILOT_GIT_HELPER_DIR` in a managed session or from this installed skill's `scripts` directory in a direct session.

1. Run `node <helper-dir>/muxpilot-git-status.mjs`. If it reports that standalone mode is uninitialized, use "Standalone initialization" below. Otherwise resolve the intended target using "Changing the target branch" below. Complete any required confirmation, branch creation, and retarget before creating a task worktree.
2. Tell the user you are creating an isolated task worktree, then run `node <helper-dir>/muxpilot-git-begin.mjs`.
3. Perform every repository content write in the returned worktree. Shared dependency directories may be linked there and their real targets are writable for test caches.
4. Before changing dependency manifests, lockfiles, or installed packages, run `node <helper-dir>/muxpilot-git-deps.mjs localize <relative-dependency-path>`. For Node dependencies this performs a transactional frozen install using the repository's exact package-manager pin and lockfile with isolated writable caches; on failure it restores the shared link. Other dependency kinds are prepared as an empty local directory and still require an explicit install. Do not localize merely to run normal validation; invoke repository tools through their package-local binaries.
5. Follow repository guidance, but default to focused file/module lint, typechecking, and tests. Do not treat the same-agent self-review step below as a PR-style review. Run repository-wide scans or test suites only when the user explicitly requests them, or when the user explicitly requests a PR-style review of a branch or ref.
6. Classify validation using "Heavyweight commands" below. Run every heavyweight command through `node <helper-dir>/muxpilot-git-run.mjs --heavy -- <command>`. The helper limits concurrent heavyweight work across muxpilot sessions, emits queue and runtime heartbeats, and observes child output, process-group CPU/I/O, and running labeled Docker containers. It warns after one minute with no observed progress, terminates after ten inactive minutes or thirty runtime minutes, and retains command output in a private capped log. When user-systemd session scopes are available, managed runs use muxpilot's private launch broker to hand the worker to a transient service, release the model turn after launch, and resume it with a compact terminal result; other runs remain synchronous. Queue time does not consume either timeout. Use per-run flags such as `--runtime-timeout 20m` only when the task itself justifies a different bound; place them before `--`.
   If the helper reports `QUEUED_NOT_RUN`, use `$muxpilot-heavy-command-queue`. The command has not run; do not poll or retry it.
   If the helper reports `RUNNING_DEFERRED`, use `$muxpilot-heavy-command-queue`, preserve the `run_released` event, and end the turn immediately. Do not poll or perform overlapping repository work. Muxpilot will resume the session with the authoritative result.
7. Make clean, logically atomic commits. Do not leave tracked or untracked task changes uncommitted.
8. Review the complete target-to-task diff yourself. Fix every actionable finding, rerun affected focused checks, commit fixes, and review again. Repeat until a final review finds nothing actionable. Any material change invalidates the prior review.
9. Run `node <helper-dir>/muxpilot-git-finish.mjs`. If the target advanced, the helper rebases and stops; rerun affected focused checks and the complete self-review loop before retrying. Resolve conflicts in the task worktree, then do the same.
10. Report completion only after the helper prints `INTEGRATED`. In managed sessions the final validated fast-forward, target-checkout update, and cleanup use the authenticated local muxpilot broker; older or unmanaged helpers retain direct local integration. Successful integration removes the worktree and temporary branch. Failed or unfinished work is preserved.

Integration is entirely local. Normal helpers never create a target branch, pull, push, publish, or reconcile a remote. Multiple tasks may target the same branch; their short final integration steps serialize, and completion order determines landing order.

## Standalone initialization

Use standalone mode only when the status helper reports that this tmux pane has no managed muxpilot Git configuration. A partial `MUXPILOT_GIT_*` environment is an error and must not fall back to standalone mode.

1. Resolve the repository entry path and intended existing local target branch from the request and repository state.
2. Name the target branch, explain that current and future task commits in this session will integrate there, and obtain explicit user approval. Initial standalone target approval is required even when the target is the currently checked-out branch.
3. Run `node <helper-dir>/muxpilot-git-init.mjs <entry-path> <target-branch> --confirm-target`, resolving `<helper-dir>` from this installed skill when `MUXPILOT_GIT_HELPER_DIR` is absent.
4. Rerun the status helper and continue the normal change-task workflow.

Standalone state is private to the current tmux pane and stored under `/tmp`. It reuses dependency directories, the shared heavyweight resource lease, and the same repository target lock as managed sessions. It does not add muxpilot workspace controls, a neutral Codex sandbox, injected developer instructions, authenticated broker integration, or deferred heavyweight-command continuation. Normal sandbox approvals may therefore still be required for Git metadata writes. A standalone finish result is reported as `INTEGRATED ... mode=standalone broker=none`.

## Heavyweight commands

Treat a command as heavyweight when any of these conditions applies:

- It scans, lints, typechecks, tests, formats, or builds an entire repository, workspace, application, package, or multi-project configuration rather than selected files or a single test target.
- It is a static-analysis, security, dependency, or container-image scan, including Semgrep, CodeQL, Trivy, or an equivalent scanner.
- It starts Docker or Docker Compose, launches multiple test workers/shards/projects, produces a production bundle, or otherwise fans out into many child processes.
- Based on the repository, command flags, or prior output, it can reasonably run for more than one minute, use more than about 1 GiB of memory, or sustain multiple CPU cores.

The following are normally not heavyweight: inspecting files or Git state, syntax-only checks, linting selected files, and running one explicitly selected test file or test case without parallel workers.

When uncertain, use the heavyweight wrapper. The wrapper only schedules an already-authorized command; it does not authorize repository-wide validation. Do not broaden a focused check into a repository-wide command merely because the wrapper is available. Do not repeat an unchanged successful heavyweight gate; rerun it only when material code, configuration, dependencies, target-base changes, or required re-review invalidates the prior result.

## Changing the target branch

Treat `muxpilot-git-status.mjs` as authoritative for the current target. The launch-time target is only the fallback before workflow status exists.

Infer target intent before beginning a change task. When a user asks to create or select a local branch for implementation, treat that destination branch as the intended session target even if the user does not explicitly say to change the muxpilot target. In a request to create `feature` from `origin/dev`, `feature` is the intended target and `origin/dev` is only its start point.

If the intended target differs from workflow status, changing it is a `fixed-target` guard bypass. When "Skill-declared authorization" below does not apply, the original request is not itself confirmation. Before creating the requested branch or beginning implementation, name the `fixed-target` guard, explain that current and future task commits will integrate into the new branch, and obtain separate explicit confirmation. If confirmation is declined, leave the branch and workflow state unchanged.

After authorization, create a requested local branch from the supplied locally available start point without checking it out, fetching, pulling, or pushing. Then run `node <helper-dir>/muxpilot-git-target.mjs <existing-local-branch> --bypass=fixed-target`. If the start point is unavailable locally, report the blocker rather than fetching implicitly. If the intended branch is already the current target, no bypass or additional authorization is required.

The helper never creates or fetches a branch. If a task worktree exists, it is preserved and finalization rebases it onto the new target when necessary. Any active-worktree retarget invalidates prior validation and review; rerun focused checks and the complete self-review loop before integration, even when Git does not need to rebase.

## Guard-specific overrides

Muxpilot guards are: `worktree-isolation`, `same-agent-review`, `focused-validation`, `atomic-commits`, `clean-target`, `fixed-target`, `local-target-only`, `automatic-cleanup`, and `no-pull-push`.

### Skill-declared authorization

A user directly invokes a skill when the current request names it, either with
the `$skill-name` form or unambiguous wording such as "use the review skill."
Description-based or otherwise automatic skill selection is not a direct
invocation.

When a directly invoked skill's instruction body explicitly directs an action
that conflicts with a muxpilot guard, the invocation itself is
operation-scoped authorization for that action. The skill does not need to name
the guard. Map the action to every affected guard, name each guard and its
consequence, announce that the skill invocation supplies authorization, and
continue without pausing for redundant confirmation. Pass the exact
`--bypass=<guard>` option when a helper supports it. This also satisfies a
skill's own instruction to obtain separate operation-scoped authorization for
the same explicitly directed action.

Authorization covers only the named skill, its current invocation, and the
actions its instruction body explicitly directs. A broad capability
description, an undeclared action, a later operation, or an automatically
selected skill does not qualify.

### Other guard conflicts

When skill-declared authorization does not apply and a user instruction
conflicts with one or more guards:

1. Name each conflicting guard and explain the concrete consequence of bypassing it.
2. Obtain explicit confirmation for those exact guards before acting. Do not infer confirmation from the original conflicting request.
3. Scope confirmation to that operation only; every unrelated guard remains active.
4. Pass an exact `--bypass=<guard>` option when a helper supports the confirmed exception. There is no blanket force option.

Platform safety, sandbox, permission, and security approval requirements are
not muxpilot guards and cannot be bypassed through either authorization
process.
