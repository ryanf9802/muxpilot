# Agent Orchestration Reference

muxpilot can expose managed Codex sessions to one another through a constrained `muxpilot_sessions` tool server. This supports durable delegated work in independently visible sessions without turning muxpilot into a general remote shell.

## Choosing a Delegation Mechanism

Use Codex's built-in subagents for routine bounded delegation, especially standard code-review passes. They run inside the current Codex session and do not create more muxpilot sessions.

Create a nested muxpilot session only when the operator explicitly requests one or when durable delegated work benefits from independent monitoring, transcript history, documents, and resource isolation. A nested session is a real Codex session with fresh model context and inherits its parent's app-server or legacy tmux driver.

## Session Trees in the UI

Agent-managed children appear beneath their parent dashboard card. Each row shows session name, status, context pressure, and remaining delegated work budget. Descendant attention rolls up to the parent; completed branches collapse under a completed-agent disclosure, and routine child status changes do not produce duplicate notifications at every level.

The dashboard action menu can attach an eligible live session to a parent, move it to another valid parent, or return it to the top level. The session header links an agent-managed child back to its parent and offers a detach action.

A root tree can contain no more than two live agent-managed descendants. Completed children remain in history but free their live concurrency slots when finished.

## Ownership and Isolation

Creating a child assigns it to the calling session. Claiming attaches an existing unowned live session. Ownership forms an acyclic tree:

- A session can control lifecycle only within its descendant tree.
- A message may be sent to any live managed session, but descendant context and budget guards still apply.
- Release returns a child to the top level without stopping it. Live descendants must be released first.
- Finish stops the selected descendant and its descendants, cancels their active heavyweight work, and retains their history.
- Security approvals always remain operator-only. An agent cannot approve a command or connector request for another session.

Agent children require a dedicated `muxpilot-session-<capability>.scope`. Creation, claim, or attachment is refused when user-systemd session scopes are unavailable or an existing session is unscoped. Enable the persistent user manager, restart muxpilot, then kill and restore affected sessions so they relaunch inside managed scopes. See [Configuration](configuration.md#resource-controls).

## Child Creation and Inheritance

A created child starts with fresh Codex context and inherits the parent's:

- Repository entry path or direct working directory.
- Current managed Git target when present.
- Default and Plan model/reasoning selections.
- Fast-mode setting.

It receives its own runtime service or pane, capability-bound tool server, resource unit, managed Git workspace identity when applicable, and private documents directory. The initial delegated task is delivered only after the child reaches a reconciled ready state.

Claiming does not restart a session or replace its existing conversation. It records ownership and a new delegated-work baseline after verifying the session and its subtree are eligible.

## Orchestration Tool Surface

The tool server exposes bounded operations rather than arbitrary shell access:

| Tool | Contract |
| --- | --- |
| `list_sessions` | List all sessions or the caller's tree with hierarchy, state, context, and budget. |
| `read_session` | Read persisted metadata, queued input, and up to 30 recent parsed messages. |
| `create_session` | Create a fresh-context child with a bounded task and optional Plan mode. |
| `claim_session` | Attach an unowned live scoped session as a child. |
| `release_session` | Detach a controlled child without stopping it. |
| `send_message` | Send work to a live session with context and budget enforcement. |
| `answer_question` | Answer a structured question in a controlled descendant. |
| `choose_plan_action` | Choose implement, clear-context implement, or remain-in-plan for a descendant. |
| `interrupt_session` | Interrupt a controlled descendant. |
| `finish_session` | Stop a controlled subtree and retain its history. |
| `extend_budget` | Add work tokens with a required audited reason. |
| `wait_for_sessions` | Arm an event-driven wait for one or two sessions. |
| `cancel_wait` | Cancel the caller's active wait. |

All operations use exact session IDs, and the broker rejects requests larger than 256 KiB. Created tasks and sent messages allow at most 200,000 characters. Transcript reads return between 1 and 30 recent messages. A wait targets one or two sessions and accepts a timeout from 1 minute through 24 hours. Control operations recheck ownership on the server.

## Context and Work-Token Guardrails

Each created or claimed child starts with a 1,000,000 work-token budget measured from the ownership baseline. Uncached input, output, and reasoning tokens count as work. Reaching the budget interrupts the child, marks it blocked, and prevents more delegated work until an ancestor extends the budget with a reason. A single extension can add at most 2,000,000 tokens.

At 70 percent active context, the bundled skill directs the parent to narrow or hand off the task. At 85 percent, muxpilot interrupts and blocks an unapproved child. Sending more work at that pressure requires an explicit high-context acknowledgement and reason. That approval is cleared when the approved turn completes so it is not a permanent bypass.

These guardrails limit delegated work; they do not alter the Codex account's own rate limits or context implementation.

## Waiting Without Polling

`wait_for_sessions` arms a durable event-driven wait for one or two exact sessions in `any` or `all` mode. The calling turn ends after the wait is armed. muxpilot watches state outside the model and resumes the parent once the requested child reaches a terminal or attention state, the wait fails, or its timeout expires.

This avoids spending model tokens on repeated status polling. The wait survives ordinary reconciliation and is removed when delivered or cancelled.

## Raw Evidence Tools

Normalized muxpilot state can be compared with independent read-only evidence:

| Tool | Evidence |
| --- | --- |
| `read_session_runtime` | Neutral runtime, exact systemd state, socket, resource unit, Codex version, and CLI attachment command. |
| `read_session_process_tree` | `/proc` and cgroup evidence rooted at either the app-server service PID or legacy pane. |
| `read_session_protocol_journal` | Bounded raw app-server request, response, notification, and connection evidence. |
| `list_tmux_panes` | Verbatim bounded `tmux list-panes` output. |
| `capture_tmux_pane` | A bounded exact pane capture with optional ANSI and wrap joining. |
| `read_tmux_process_tree` | `/proc` command, status, cgroup, and child records for a pane. |
| `list_codex_session_files` | Filesystem metadata for recent Codex JSONL files. |
| `read_codex_session_file` | A bounded byte slice from an exact listed JSONL path. |

These tools diagnose discrepancies; they do not decide which source is correct or authorize remediation.

Pane capture is limited to 2,000 lines. Codex file listings return at most 500 entries per page, and an exact file read is limited to a 256 KiB byte slice. Paths must come from the configured Codex session root and pass the broker's relative-path checks.

## Documents and Handoffs

Every muxpilot session owns a private `$MUXPILOT_DOCUMENTS_DIR`. Parent documents are canonical program state. A nested child may read explicitly supplied parent document paths, but it cannot edit the parent's scope. It returns independently verified evidence and proposed plan, acceptance, workflow, or reminder updates for the parent to verify and apply.

Built-in Codex subagents share the current session's environment and document directory. They should return proposed document changes without writing canonical session documents themselves.

Documents are copied into an independent scope when a conversation is forked and included in session transfers. See [Usage](usage.md#session-documents) for limits and the operator viewer.

## BTW Side Questions

BTW runs a separate, non-interrupting Codex turn from a fresh snapshot of the main conversation. Each question is independent and has its own saved answer, progress state, cancellation control, and copy actions. It cannot request interactive input or approvals, and a run is bounded to two minutes.

A BTW request may also create or edit session documents. It works in isolated staging and cannot delete or rename documents or write elsewhere. muxpilot validates the staged diff, waits for a safe boundary, and applies it atomically. If canonical documents changed meanwhile, BTW regenerates once from the latest state and otherwise reports a conflict without overwriting them. The main agent receives an internal notice and remains responsible for reconciling and maintaining canonical documents.

BTW history is independent side-question history, not a branch of the main transcript. It is local to the source session and is not copied as normal composer or queued-input state.

## Security Boundary

The orchestration broker exposes session operations, bounded transcript reads, and read-only diagnostic evidence. It does not expose arbitrary commands, arbitrary filesystem reads, approval bypasses, Git publication, deployment, or access to another session's private documents.

Capabilities are bound to the session that launched with them. Ownership, scope, context, and budget checks are enforced again by the server rather than trusted to the prompt alone. The bundled `$muxpilot-session-orchestration` and `$muxpilot-documents` skills are the normative agent procedures.
