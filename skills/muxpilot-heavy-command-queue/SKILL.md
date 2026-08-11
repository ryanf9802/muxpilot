---
name: muxpilot-heavy-command-queue
description: Release a Codex turn when muxpilot defers a heavyweight command, and safely reclaim its reserved slot from an automatic continuation. Use when muxpilot-git-run reports QUEUED_NOT_RUN or when muxpilot sends a heavyweight-slot resume message.
---

# Muxpilot Heavy Command Queue

When `muxpilot-git-run.mjs` prints `QUEUED_NOT_RUN`, the command did not run. Treat it as neither a pass nor a validation failure.

1. Do not poll, sleep, or retry the command.
2. Continue genuinely useful work that does not depend on the deferred command and is not another heavyweight command.
3. If only queue waiting remains, give the user a concise queue update and end the turn immediately. Do not claim completion.
4. Preserve the task worktree and all unfinished state.

When muxpilot sends a reservation continuation, run the exact resume command from that message before doing other work. Do not reconstruct or alter it. A resume rejection or expiration means the original command remains unrun; report that boundary and do not call it a test failure.

User messages received while queued are delivered after the resumed task finishes. Do not manually answer or replay queued drafts from the continuation text.
