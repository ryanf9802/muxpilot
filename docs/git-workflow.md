# Local Git Workflow Reference

muxpilot gives Codex sessions a local Git workflow built around short-lived task worktrees. It is designed for concurrent local implementation without letting an agent write directly into the target checkout.

The workflow integrates commits into an existing local branch. It does not fetch, pull, push, publish, or create a pull request.

## Execution Modes

### Managed sessions

A Git-backed session created by muxpilot starts in a neutral control directory. The session records:

- The repository entry path and repository root.
- An existing local target branch and its current commit.
- A private workflow status file observed by the muxpilot UI.
- Reusable dependency directories that can be linked into task worktrees.

The repository is inspected directly for read-only work. A task worktree is created only when the request requires repository writes.

Managed sessions receive muxpilot's sandbox roots, launch instructions, bundled skills, authenticated integration broker, resource controls, and deferred heavyweight-command continuation.

### Standalone sessions


Its session-specific state lives under `/tmp` by default and reuses the same dependency candidates, target lock, and heavyweight lease as managed tasks. It does not retrofit the managed neutral workspace, sandbox roots, launch instructions, authenticated broker, resource scope, or automatic heavyweight queue continuation. Ordinary filesystem approvals may still be required.

## Target Branch Contract

The workflow status returned by `muxpilot-git-status.mjs` is authoritative. The branch selected when a session was created is only the initial target before workflow state exists.

When a request names a new destination branch for implementation, that destination is target intent even if it is described as being created from another ref. The source ref is only the starting point. Before changing the fixed target, the agent must:

1. Name the `fixed-target` guard.
2. Explain that current and future task commits will integrate into the new branch.
3. Obtain separate, explicit operator confirmation unless the direct skill-invocation authorization below applies.
4. Create the local branch when requested, then retarget with `muxpilot-git-target.mjs`.

Retargeting an active worktree invalidates its prior checks and review. They must be repeated before integration.

## Change Lifecycle

The bundled `$muxpilot-git-workflow` skill drives this sequence:

1. **Resolve status and target.** Confirm the current workflow state before creating a worktree.
2. **Begin.** `muxpilot-git-begin.mjs` creates or adopts a private implementation branch and worktree based on the target.
3. **Implement in isolation.** Every repository content write occurs in that worktree.
4. **Localize dependencies when changing them.** `muxpilot-git-deps.mjs localize` replaces a shared dependency link with task-local state before a manifest, lockfile, or installed package is changed.
5. **Validate.** Run checks that cover the changed files or modules and any full build required by repository guidance. Other repository-wide work requires explicit operator scope.
6. **Commit atomically.** All tracked and untracked task changes must belong to clean logical commits.
7. **Self-review.** Review the complete target-to-task diff, fix every finding, rerun affected checks, and repeat until clean.
8. **Finish.** `muxpilot-git-finish.mjs` verifies the task, serializes integration, and fast-forwards the local target.
9. **Clean up.** Successful integration removes the temporary branch and worktree. A failed, blocked, or conflicted task is retained for recovery.

Multiple sessions may target the same branch. Their final integration steps are serialized, and landing order is completion order. If the target advances first, the task rebases and returns to validation and review before it can finish.

## Dependency Reuse

At session creation, muxpilot records dependency candidates such as Node `node_modules`, Python virtual environments, Composer vendors, or Bundler state. A task worktree can link those existing directories for ordinary checks without reinstalling them.

Dependency localization is required only before changing dependency manifests, lockfiles, or installed contents. Node localization uses the repository's exact package-manager pin and lockfile with isolated caches and restores the shared link if the frozen install fails. Other ecosystems receive an empty task-local dependency directory and still need their normal install command.

## Validation and Heavyweight Commands

Selected-file lint, syntax checks, or one explicitly selected test file are normally focused. A command is heavyweight when it covers an entire repository, package, application, or multi-project configuration; runs a scanner or production build; starts Docker; launches multiple workers; or is expected to use substantial time, memory, or CPU.

Heavyweight work runs through `muxpilot-git-run.mjs --heavy -- <command>`. The wrapper:

- Applies a shared concurrency limit across sessions.
- Records queue, process, output, CPU/I/O, and labeled-container activity.
- Warns on prolonged inactivity and enforces inactivity, runtime, and termination deadlines.
- Retains child output in a private capped log and preserves the signal and exit status.

When capacity is unavailable, the helper prints `QUEUED_NOT_RUN`; the command has not run. The agent releases its turn instead of polling. muxpilot reserves the FIFO ticket and later resumes the session with an exact claim command. Queue and resume transitions appear as structured transcript events. See [Runtime Reliability](runtime-reliability.md#heavyweight-command-scheduler) for the operator view.

After a managed command starts, the helper asks muxpilot's private host-side broker to place its worker in a transient user-systemd service, prints `RUNNING_DEFERRED`, and emits a structured `run_released` event. The agent ends its turn instead of polling. Muxpilot resumes it with one `run_completed` event containing a compact success result or a bounded failure tail plus the retained-log path. Standalone helpers and managed installations without user-systemd session scopes continue to return the child result synchronously.

The scheduler controls resources only. Repository guidance may authorize a required full build, but the scheduler does not authorize a broader test or scan than the operator requested.

## Workflow Events and UI State

Helpers emit structured events that muxpilot renders in the transcript:

| Event | Meaning |
| --- | --- |
| `workflow_initialized` | Standalone mode accepted its initial target. |
| `worktree_created` / `worktree_adopted` | An isolated implementation worktree is active. |
| `target_changed` | The confirmed local target changed. |
| `review_required` | A rebase or retarget invalidated previous validation and review. |
| `integration_completed` | Commits were integrated into the local target. |
| `workflow_blocked` / `workflow_failed` | The operation stopped and retained recoverable state. |

The dashboard and session header show the target branch and current workflow state. The Git workspace panel exposes the target commit, task branch/worktree name, state, update time, and last workflow error.

## Guards

The workflow enforces these named guards:

- `worktree-isolation`
- `same-agent-review`
- `focused-validation`
- `atomic-commits`
- `clean-target`
- `fixed-target`
- `local-target-only`
- `automatic-cleanup`
- `no-pull-push`

A direct skill invocation is operation-scoped authorization when the request
names the skill with `$skill-name` or unambiguous wording and the skill body
explicitly directs the guard-conflicting action. The skill need not identify
the guard. The agent still names each mapped guard and consequence, announces
the skill-derived authorization, and uses the exact helper bypass without
pausing for redundant confirmation. Automatic skill selection, broad
capability descriptions, undeclared actions, and later operations do not
qualify.

For all other conflicts, an operator can approve a specific guard bypass for a
specific operation only after the agent names the guard and consequence. There
is no blanket force option. Platform safety, sandbox, permission, and security
approvals are separate and cannot be bypassed through workflow guards.

## Integration Boundaries and Recovery

Integration stops rather than modifying a dirty target checkout. It also stops for unresolved conflicts, an invalidated review, missing commits, uncommitted task files, or a target that cannot be fast-forwarded safely.

Do not use an implementation worktree to report whether another checkout is clean. Inspect the actual target checkout. A retained worktree is the recovery surface: resolve conflicts or incomplete work there, repeat focused checks, any repository-required build, and the complete review, then retry finish.

Successful local integration is distinct from a remote push, pull request, merge, deployment, or production restart. Each requires its own operator request and evidence.

## Helper Summary

| Helper | Purpose |
| --- | --- |
| `muxpilot-git-status.mjs` | Read authoritative target and task state. |
| `muxpilot-git-init.mjs` | Initialize standalone mode after target confirmation. |
| `muxpilot-git-target.mjs` | Change to an existing confirmed local target. |
| `muxpilot-git-begin.mjs` | Create or adopt the isolated task worktree. |
| `muxpilot-git-deps.mjs` | Localize a dependency directory before dependency changes. |
| `muxpilot-git-run.mjs` | Schedule and monitor heavyweight commands. |
| `muxpilot-git-finish.mjs` | Rebase when needed, verify, integrate, and clean up. |

The installed skill is the normative agent procedure. This guide explains its contract for operators and contributors.
