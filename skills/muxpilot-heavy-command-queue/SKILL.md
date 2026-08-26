---
name: muxpilot-heavy-command-queue
description: Release a Codex turn when muxpilot defers a heavyweight command, and safely reclaim its reserved slot from an automatic continuation. Use when muxpilot-git-run reports QUEUED_NOT_RUN or when muxpilot sends a heavyweight-slot resume message.
---

# Muxpilot Heavy Command Queue

When `muxpilot-git-run.mjs` prints `QUEUED_NOT_RUN`, the command did not run. Treat it as neither a pass nor a validation failure. Preserve the complete `<muxpilot_heavy_command_queue>...</muxpilot_heavy_command_queue>` event printed with it.

1. Do not poll, sleep, or retry the command.
2. Continue genuinely useful work that does not depend on the deferred command and is not another heavyweight command.
3. If only queue waiting remains, return exactly the preserved queue event with no surrounding prose and end the turn immediately. Do not claim completion.
4. Preserve the task worktree and all unfinished state.

When muxpilot sends a `<muxpilot_heavy_command_queue>` event whose `kind` is `resume_requested`, run its `resumeCommand` string exactly before doing other work. Do not reconstruct or alter it. A resume rejection or expiration means the original command remains unrun; report that boundary and do not call it a test failure.

`LEASE_ACQUIRED` or `COMMAND_STARTED` output means the original wrapper invocation owns the live run. Continue waiting on that same execution handle; never construct a `--resume` command from its run id. Only the exact `resumeCommand` inside a `resume_requested` event may claim a deferred reservation. If the original invocation later reports `COMMAND_EXITED`, that exit result is authoritative.

Muxpilot holds user messages while a run is waiting or reserved. If an ordinary user message arrives before a resume request, treat its delivery as proof that muxpilot ended the deferred phase, such as through an operator interrupt. Stop waiting for the old run, do not retry it, and handle the delivered message normally. Treat any later resume request for that ended run as stale. Messages held while a resumed command runs arrive only after that task finishes. Do not manually answer or replay queued drafts from continuation text.
