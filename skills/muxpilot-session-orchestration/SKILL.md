---
name: muxpilot-session-orchestration
description: Coordinate muxpilot sessions through the session tools, including delegated children, bounded context inspection, event-driven waits, and explicit token-budget control.
---

# Muxpilot Session Orchestration

Use the tools exposed by `muxpilot_sessions` when a task benefits from another muxpilot session. These tools coordinate independent Codex sessions; they do not create in-process subagents.

## Visibility and messaging

- Use `list_sessions` to inspect session IDs, hierarchy, status, context use, and delegated work budgets.
- Use `read_session` for a bounded recent transcript. Read only what the current decision needs.
- When muxpilot's normalized state may be wrong, inspect independent evidence with `list_tmux_panes`, `capture_tmux_pane`, `read_tmux_process_tree`, `list_codex_session_files`, and `read_codex_session_file`. Compare the raw sources yourself; the tools do not classify mismatches.
- Raw evidence tools are diagnostic and read-only. Report factual inconsistencies and wait for separate operator direction before attempting remediation.
- You may send a work message to any live managed session by exact ID. The transcript records you as the delegating session.
- Claim only an unowned session. Release, interrupt, finish, or otherwise control lifecycle only for sessions in your descendant tree.
- A claimed or created child must report an isolated muxpilot resource scope. If isolation is unavailable, stop and ask the operator to enable the user systemd manager, restart muxpilot, and restore the target session.
- Never answer or bypass a security approval for another session. Approval decisions remain with the operator.

## Delegated children

Create a child with a concrete, bounded task. A child starts with fresh model context, inherits the parent repository, target, cwd, and launch settings, and runs in its own resource scope. No more than two live descendants may exist within one operator-rooted tree.

Before delegating, state the expected result and what evidence the child should return. Avoid duplicating work already in progress elsewhere.

## Waiting without token burn

After delegating work that blocks your next step, call `wait_for_sessions`. A successful wait ends the current turn. Muxpilot watches lifecycle events outside the model and sends exactly one structured wake-up message when a requested condition is satisfied, fails, or reaches its timeout. Do not poll with repeated list or transcript calls.

Use `cancel_wait` only when the dependency no longer blocks your work. If continuing work is useful while a child runs, continue and inspect it later instead of arming a wait.

## Context and work-token guardrails

Every orchestration response reports context-window use and delegated work-token use when available. At 70 percent context, narrow or hand off the task. At 85 percent, sending more work requires an explicit high-context reason. Delegated children default to a 1,000,000 work-token budget measured from creation or claim; uncached input, output, and reasoning tokens count. Extend a budget only with a specific audited reason.

Finish or release children promptly once their result has been incorporated. Finishing a child stops it; it does not merge Git work or authorize deployment, publication, or any other external mutation.
