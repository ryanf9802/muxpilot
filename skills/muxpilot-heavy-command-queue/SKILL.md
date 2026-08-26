---
name: muxpilot-heavy-command-queue
description: Release a Codex turn while heavyweight work is queued or running, safely reclaim a reserved slot, and continue from an automatic completion event.
---

# Muxpilot Heavy Command Queue

When `muxpilot-git-run.mjs` prints `QUEUED_NOT_RUN`, the command did not run. Treat it as neither a pass nor a validation failure. Preserve the complete `<muxpilot_heavy_command_queue>...</muxpilot_heavy_command_queue>` event printed with it.

1. Do not poll, sleep, or retry the command.
2. Continue genuinely useful work that does not depend on the deferred command and is not another heavyweight command.
3. If only queue waiting remains, return exactly the preserved queue event with no surrounding prose and end the turn immediately. Do not claim completion.
4. Preserve the task worktree and all unfinished state.

When muxpilot sends a `<muxpilot_heavy_command>` event whose `kind` is `resume_requested`, run its `resumeCommand` string exactly before doing other work. The legacy `<muxpilot_heavy_command_queue>` tag has the same meaning. Do not reconstruct or alter the command. A resume rejection or expiration means the original command remains unrun; report that boundary and do not call it a test failure.

Managed runs may emit a `<muxpilot_heavy_command>` event whose `kind` is `run_released`. The command is running under muxpilot supervision even though the launcher exits with its control-plane handoff code. Return exactly the preserved event with no surrounding prose and end the turn immediately. Do not poll, start overlapping repository work, or treat the launcher status as the validation result.

Muxpilot resumes the session with a `run_completed` event after the worker exits. Its outcome, exit code, signal, duration, and retained-log path are authoritative. A successful event intentionally omits child output. A failed or terminated event includes a bounded diagnostic tail; read the retained log only when the tail is insufficient. Continue the workflow from that result without rerunning an unchanged successful gate.

Without a `run_released` event, `LEASE_ACQUIRED` or `COMMAND_STARTED` output means the original wrapper invocation owns the live run. Continue waiting on that same execution handle; never construct a `--resume` command from its run id. Only the exact `resumeCommand` inside a `resume_requested` event may claim a deferred reservation.

Muxpilot holds user messages while a run is waiting, reserved, running, or reporting. If an ordinary user message arrives before a resume or completion event, treat its delivery as proof that muxpilot ended the deferred phase, such as through an operator interrupt. Stop waiting for the old run, do not retry it, and handle the delivered message normally. Treat any later event for that ended run as stale. Held messages arrive only after the task finishes. Do not manually answer or replay queued drafts from continuation text.
