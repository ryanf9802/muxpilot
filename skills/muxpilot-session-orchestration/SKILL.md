---
name: muxpilot-session-orchestration
description: Coordinate muxpilot sessions through the session tools, including delegated children, bounded context inspection, event-driven waits, and explicit token-budget control.
---

# Muxpilot Session Orchestration

Use built-in Codex subagents for routine bounded delegation, especially standard code-review passes. Do not create a nested muxpilot session merely to run a review in parallel. If built-in subagents are unavailable, keep the review in the current session instead of substituting a nested muxpilot session.

Use the tools exposed by `muxpilot_sessions` only when the operator explicitly requests a nested muxpilot session or the delegated work is durable and benefits from independent monitoring and its own resource scope. These tools coordinate independent Codex sessions; they do not create in-process subagents.

## Visibility and messaging

- Use `list_sessions` to inspect session IDs, hierarchy, status, context use, delegated work budgets, and Codex thread-goal objective, state, elapsed time, and token use when available.
- Use `read_session` for the same goal telemetry plus a bounded recent transcript. Read only what the current decision needs.
- When muxpilot's normalized state may be wrong, inspect independent evidence with `list_tmux_panes`, `capture_tmux_pane`, `read_tmux_process_tree`, `list_codex_session_files`, and `read_codex_session_file`. Compare the raw sources yourself; the tools do not classify mismatches.
- Raw evidence tools are diagnostic and read-only. Report factual inconsistencies and wait for separate operator direction before attempting remediation.
- You may send a work message to any live managed session by exact ID. The transcript records you as the delegating session.
- Claim only an unowned session. Release, interrupt, finish, or otherwise control lifecycle only for sessions in your descendant tree.
- A claimed or created child must report an isolated muxpilot resource scope. If isolation is unavailable, stop and ask the operator to enable the user systemd manager, restart muxpilot, and restore the target session.
- Never answer or bypass a security approval for another session. Approval decisions remain with the operator.

## Delegated children

Create a child with a concrete, bounded task. A child starts with fresh model context, inherits the parent repository, target, cwd, and launch settings, and runs in its own resource scope. No more than two live descendants may exist within one operator-rooted tree.

Before delegating, state the expected result and what evidence the child should return. Avoid duplicating work already in progress elsewhere.

### Durable document handoffs

Every agent-created muxpilot child session has its own private `$MUXPILOT_DOCUMENTS_DIR`; it does not share the parent's document scope. Parent documents are canonical program state. A muxpilot child may read explicitly supplied parent document paths, but must never edit them or place muxpilot documents in its session cwd. It keeps optional working notes in its own documents directory and returns a structured handoff with:

- independently verified evidence;
- proposed plan/progress changes;
- proposed acceptance-gate changes; and
- proposed workflow or reminder changes.

The parent verifies the evidence, applies accepted changes to its canonical documents, and rejects or corrects unsupported child conclusions before continuing.

Built-in Codex subagents are not muxpilot child sessions: they share the main agent's environment and documents directory. Tell them not to edit session documents and to return proposed document changes to the main agent.

## Waiting without token burn

After delegating work that blocks your next step, call `wait_for_sessions`. A successful wait ends the current turn. Muxpilot watches lifecycle events outside the model and sends exactly one structured wake-up message when a requested condition is satisfied, fails, or reaches its timeout. Do not poll with repeated list or transcript calls.

Use `cancel_wait` only when the dependency no longer blocks your work. If continuing work is useful while a child runs, continue and inspect it later instead of arming a wait.

## Context telemetry and work-token budgets

Every orchestration response reports context-window use and delegated work-token use when available. Context-window use is informational; let Codex manage its context and automatic compaction. Delegated children default to a 1,000,000 work-token budget measured from creation or claim; uncached input, output, and reasoning tokens count. Extend a budget only with a specific audited reason.

`list_sessions` and `read_session` also report the Codex thread goal when one exists, including its objective, status, elapsed seconds, consumed tokens, optional token budget, and source timestamps. Check `goalTelemetry.available` before interpreting `goal: null`: an available source with a null goal means that thread has no recorded goal, while an unavailable source means muxpilot could not inspect Codex's goal store.

Finish or release children promptly once their result has been incorporated. Finishing a child stops it; it does not merge Git work or authorize deployment, publication, or any other external mutation.
