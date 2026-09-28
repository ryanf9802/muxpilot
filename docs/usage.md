# Usage Guide

muxpilot is an operator console for durable Codex and Claude sessions. This guide covers the workflows and controls available after [setup](setup.md).

## Dashboard

The dashboard groups sessions by repository and makes their attention state visible at a glance. Session cards can show:

- Current status and attention color
- Repository, branch, working directory, and dirty-worktree state
- Recent user prompts
- Transcript size and runtime availability
- A provider badge when more than one provider is enabled or sessions mix providers
Search matches session names, repository names, branches, working directories, previews, and recent prompts. Use a session's action menu to rename it, configure notifications, fork it, or end it.

Repository groups can be collapsed and remember that choice in the browser. Pinned sessions sort ahead of other sessions in their repository. The three-color stoplight in the top bar shows the current attention totals; selecting a color filters the dashboard to that severity while preserving any parent rows needed to explain matching agent children.

The dashboard shows one usage panel per enabled provider, side by side on wide screens. Each panel shows that provider's sign-in state and, when sign-in is needed, a copyable host login command (`codex login` or `claude auth login`). muxpilot never signs in on the operator's behalf.

The Claude usage panel shows the plan's limit windows reported by Claude Code, such as the five-hour and weekly limits, updated by rate-limit events from live sessions, and daily token activity read from Claude transcripts.

For authenticated ChatGPT accounts, the Codex usage panel shows the current limit windows, earned usage-reset tokens and their expiration details, and daily token activity over the past 30 days. Using a reset token requires confirmation. If the result is interrupted, the panel checks that same redemption once automatically. If it still cannot confirm the outcome, **Retry** checks the same attempt without consuming another token. Refresh reloads account limits, reset tokens, and token activity directly from Codex.

When systemd resource metrics are available, a card shows current memory and CPU pressure. Fast-mode, notification, fork, managed-Git, transcript-size, and pin indicators expose other session state without opening the card. Agent-managed descendants render as a tree beneath the owning session with their own status, context percentage, and remaining work-token budget. Completed branches collapse into a separate disclosure.

## Session view

Opening a session shows its structured Codex or Claude transcript. muxpilot keeps user prompts, assistant responses, approvals, questions, proposed plans, aborts, and other important events visible while collapsing noisier tool activity and command output.

The session view also provides:

- Expandable activity groups and transcript ranges
- Normal and Plan input modes
- Queue-aware input with editable pending messages
- Inline approval, question, and proposed-plan controls
- Prompt skill suggestions and optional Vim composer mode
- Normal/Plan collaboration controls and model-dependent Fast mode
- Transcript search, paging, and jump controls
- Context-window use, managed Git state, documents, BTW side questions, and active heavyweight-command details
- A copyable local runtime attachment command for Codex sessions
- Interrupt, fork, new-session, and kill actions
- For Claude sessions, an **Agents** view of the subagents and background tasks Claude Code is running

The permissions selector in the session model-settings drawer is stored per root session and always starts at **Ask for approval**. Agent-managed child sessions continuously inherit their parent's setting; their selector shows the effective mode but cannot be changed independently. Detaching a child resets its mode to Ask. **Auto approval** uses the provider's app-wide reviewer to approve clearly in-scope runtime actions, deny clearly out-of-scope actions, and return uncertain or high-impact requests to you. **Full approval** grants runtime requests automatically. Questions and plan choices remain interactive in every mode. Configure each provider's Auto reviewer model and reasoning effort with the reviewer apply action in the dashboard's model-defaults drawer; the Claude reviewer defaults to `haiku`.

For Claude sessions, muxpilot's modes map onto Claude Code's own permission modes:

| muxpilot | Claude Code |
| --- | --- |
| Normal, with Ask or Full approval | `acceptEdits`: file edits in the session's writable roots apply without a prompt |
| Normal, with Auto approval | `auto`: Claude Code's own classifier approves or denies permission prompts |
| Plan | `plan` |

If Claude Code's auto mode isn't available for the signed-in account or model, the session falls back to `acceptEdits`. A transcript notice says so, and muxpilot's Auto reviewer handles the remaining prompts instead. Claude can also enter plan mode on its own; muxpilot's Plan toggle follows it.

Claude sessions always run inside Claude Code's sandbox. Reads and sandboxed commands proceed without a prompt. A command that asks to run outside the sandbox, an edit outside the writable roots, and other tool use become approval requests handled by the selected permissions mode. An approval raised inside a subagent names the subagent that asked.

User prompts render Markdown, including tables, lists, task markers, links, and fenced code. Tool activity, Git lifecycle events, heavyweight queue handoffs, and assistant progress are grouped separately so operational events remain visible without turning the transcript into a terminal log.

## Creating sessions

Open the new-session dialog or press `Ctrl+N`.

The Create tab asks for:

- **Provider:** Codex or Claude, when more than one provider is enabled
- **Directory:** the repository or working directory in which the agent should start
- **Name:** the muxpilot display name
- **Target branch:** an existing local branch used as the integration destination for managed Git work

Directory suggestions come from active sessions and recently touched repositories. Names are normalized to 2–32 lowercase letters, numbers, or hyphens.

The provider choice shows each provider's readiness and skips providers that cannot start sessions; a signed-out provider shows the host login command. The initial choice is the current session's provider, then the last provider used, then the server default. Muxpilot creates and owns a user service and Unix socket for each live session: a Codex app-server for Codex, or a muxpilot Claude session host for Claude.

Some features are provider-specific. Claude sessions do not support terminal attachment, Codex thread goals, or usage-reset tokens. Claude skills are invoked with `/name` at the start of a message rather than `$name`.

For Claude, muxpilot passes through what Claude Code already does natively rather than re-implementing it: subagents and background agents, workflows, compaction, memory (`CLAUDE.md` and auto memory), hooks, plugins, skills and slash commands, task checklists, cross-session messaging, and scheduled wakeups (`/loop`, `ScheduleWakeup`, and cron jobs). A pending wakeup or cron job keeps the session from hibernating, because those only fire while the Claude runtime is alive. Claude Code's own worktree tools stay disabled because muxpilot's Git workflow manages worktrees.

### Managed Git sessions

For a Git repository, muxpilot starts the agent from a neutral control directory and makes applicable repository skills available there. The bundled Git workflow creates a short-lived task worktree only when a change is needed.

The workflow:

1. Isolates repository writes in a task worktree.
2. Links existing dependency directories where safe.
3. Runs focused validation and iterative self-review.
4. Creates atomic commits.
5. Rebases when the target advances and repeats affected checks.
6. Locally fast-forwards the selected target branch after final validation.
7. Removes the completed task worktree and temporary branch.

The target branch must already exist locally. Selecting or creating a different implementation branch requires explicit confirmation because current and future task commits will integrate there, unless a directly invoked skill explicitly directs that guarded action. In that case the invocation supplies operation-scoped authorization, while automatic skill selection and undeclared actions do not. muxpilot does not automatically fetch, pull, push, or publish changes. A dirty target checkout blocks integration.

Heavy validation—such as repository-wide checks, production builds, scanners, Docker workloads, or multi-worker tests—uses a shared resource lease. That scheduler controls concurrency but does not authorize broader validation than the user requested.


See [Local Git Workflow](git-workflow.md) for the helper lifecycle, target guard, dependency localization, event schema, heavyweight classification, and recovery boundaries.

## BTW side questions

Open **BTW** in a session header to ask a separate question without interrupting the main turn. Each request uses a fresh snapshot of the main conversation, runs independently, and keeps its own question, streamed answer, completion state, and copy controls in the drawer. Closing the drawer does not cancel it; a completed answer adds an unread indicator until the drawer is opened.

For Claude sessions, BTW answers from an unpersisted fork of the conversation with read-only file tools, plus document writes when documents are enabled.

BTW cannot pause for interactive input or security approval. A running request can be cancelled. Its saved history is a list of independent side questions, not extra turns injected into the main transcript.

A BTW request can also create or edit session documents. Those changes are staged and validated away from the canonical files, then applied at a safe main-session boundary. The drawer shows whether a document update is waiting, retrying, applied, or conflicted and links to affected documents. See [Agent Orchestration](agent-orchestration.md#btw-side-questions) for isolation and conflict behavior.

## Session documents

Every session created or restored by muxpilot has a private documents directory available to its agent through `$MUXPILOT_DOCUMENTS_DIR`. The bundled `muxpilot-documents` skill teaches the agent to use flat Markdown files for durable implementation plans, checklists, reminders, decisions, requirements, and acceptance criteria, and to revisit and update them as work progresses. Agents consolidate or retire obsolete working notes at task transitions and milestones, and maintain `INDEX.md` as a concise navigation map rather than a progress log.

The main agent has the same document capabilities in Plan mode as in Default mode. It may autonomously maintain agent working notes, including automatically saved approved plans, and `INDEX.md` identifies documents as agent-managed or user-requested. Explicitly user-requested documents require permission before editing, renaming, or deletion unless the operator already authorized that change. Producing a formal proposed plan does not save it immediately. When the operator selects **Implement** or **Clear context and implement**, muxpilot saves the approved proposal as a separate `plan-<message-sequence>.md` file and indexes it before implementation begins. **Stay in Plan mode** leaves the proposal unsaved.

The environment variable is the only documents directory; the session working directory and repository are not document storage. Agent-created muxpilot child sessions receive private document scopes rather than shared write access. A parent keeps canonical program documents, while muxpilot children keep optional private notes and return proposed document updates for the parent to verify and apply. Built-in provider subagents, such as Codex subagents or Claude's Task tool, share the current session's scope and return proposed updates without editing its documents.

Open **Documents** in the session header to browse the current files and rendered Markdown. Relative links from one listed document to another, such as links in `INDEX.md`, switch the viewer in place; external links open separately. The operator view is read-only; document creation and editing remain agent-managed. Documents persist when a session is missing, archived, killed, or restored.

The **BTW** drawer can also create or edit documents from a plain-language request while the main agent keeps working. The BTW agent works in an isolated copy and cannot delete or rename documents or write elsewhere. muxpilot validates the changes, waits for a safe boundary, applies them atomically, and gives the main agent a private notice so it can re-read and maintain the changed documents. If the canonical files change meanwhile, BTW regenerates once from the latest versions and otherwise fails without overwriting them. If accumulated documents already exceed a count or size limit, BTW remains available for read-only questions and shows a warning that the main session must clean up documents before BTW editing can resume.

A session supports at most 100 safe, flat `.md` files, 256 KiB per file, and 10 MiB total. The viewer and transfer system reject nested paths, dotfiles, symlinks, non-UTF-8 content, and files outside those limits. Do not use session documents for credentials, tokens, raw transcripts, or other unnecessary sensitive data.

## Restoring sessions

The History tab in the new-session dialog searches sessions previously managed by muxpilot. Search covers submitted user prompts, not assistant messages or tool output.

Selecting a live result opens its existing runtime. Selecting a missing or archived result resumes the exact provider conversation and keeps the same muxpilot session identity.

If muxpilot stops without a clean shutdown, it records which non-archived session runtimes were open. On the next startup, any that are now missing appear together in a recovery dialog. All candidates are selected by default, so they can be reopened in one batch or reviewed first. Choosing **Not now** dismisses the batch; each conversation remains available from History.

Recovery restores the durable provider conversation, muxpilot metadata, documents, orchestration ownership, and any managed Git workspace binding. It does not claim that an interrupted shell command was safely resumed; background-terminal evidence is reconciled independently.

## Forking sessions

Use **Fork session** from the session header or dashboard action menu to branch a conversation at its current persisted tip. The child retains a **Forked from** link while the source remains available locally.

Forking is allowed while the source is working, but the provider may record its partial turn as interrupted. A fork keeps its source's provider. Queued inputs, composer drafts, pins, notifications, and other transient UI state are not copied.

A fork receives an independent snapshot of the source session's documents. A fork of a managed Git session inherits the same target branch but receives its own managed workspace. Unintegrated files from the source worktree are not copied; the fork starts from the current target branch.

## Agent delegation

Routine bounded delegation, including standard code-review passes, uses the provider's built-in subagents and does not create nested muxpilot sessions. If built-in subagents are unavailable, the review remains in the current session.

Claude sessions prefer Claude Code's native subagents even for long-running or parallel work. The session's **Agents** view lists the subagents, background shells, monitors, and workflows Claude Code is running or has run. Each entry shows its status, type, progress summary, last tool, and token use. Open a subagent to read its own transcript, which refreshes while it runs, or stop it. A Task tool row in the main transcript links to the subagent it started. Subagent transcripts are kept in muxpilot's transcript archive with the rest of the session, so they stay readable after Claude Code's retention sweep.

Nested muxpilot sessions are reserved for work the operator explicitly requests as a separate session or durable delegated work that benefits from independent monitoring and its own resource scope. From a Claude session, that means an explicit request or a child on a different provider. Those sessions remain visible in muxpilot and use the session-orchestration lifecycle and resource guardrails.

An operator can manage a live session's parent from the dashboard action menu or detach a child from its session header. A root tree supports two live agent-managed descendants; finishing a child keeps its history while freeing its live slot. Child attention and completion roll up to the parent, while routine nested status changes are deduplicated for notifications.

Created children use the parent's provider unless the delegating agent names another. They run in their own service and inherit the source repository/target, plus model settings and the Fast setting when the provider matches, while starting with fresh context, their own resource unit, Git identity, and documents. See [Agent Orchestration](agent-orchestration.md) for ownership controls, tool operations, resource prerequisites, context telemetry, work-token budgets, waits, and raw evidence.

## Moving sessions between hosts

The transfer dialog exports one or more sessions to a format-v8 `.mpsession` archive that records each session's provider. On the destination host, map each source repository or directory to its new path and import the archive. muxpilot restores Codex or Claude transcripts, session documents, provider identity, and preferences, then resumes each session through its provider. Format-v6 and v7 archives remain importable as Codex sessions; earlier formats are not supported.

For managed Git sessions, current exports can include the committed local target branch and objects not available from its upstream. Import may create, reuse, or safely fast-forward the same branch name. It never fetches, pulls, pushes, overwrites divergent history, or replaces a conflicting upstream.

Transfer archives do not contain dirty files, staged or untracked changes, stashes, active worktrees, dependencies, Git LFS payloads, submodule repositories, queued input, notification rules, machine-wide Codex or Claude configuration, or live processes. Copy or clone the repositories separately.

Choose a passphrase in the transfer dialog when exporting, then enter the same passphrase before selecting the archive on the importing host. New exports are always encrypted; legacy plaintext archives remain importable.

## Session variables and secrets

Open **Variables** in a session to save an environment variable. The value is write-only after saving: muxpilot returns its name and lifecycle state to the UI, while the value remains encrypted in local storage. Tell the agent to use the variable by name instead of putting its value in a prompt or command.

Changes apply when that session starts its next turn at a safe boundary. An active turn keeps its current environment. Agent-created child sessions reference their parent's variables and may override a name locally; they do not receive stored copies. A program running inside the session can read and print its environment, so avoid asking agents to display variables, run environment dumps, or enable shell tracing around credentials.

## Sending and queuing input

muxpilot persists every input before delivery. It sends a structured provider turn with a stable client message ID and reconciles uncertain delivery before retrying.

- `Ctrl+Enter` submits the composer.
- Input is sent immediately when the agent is ready.
- Input is queued while the agent is busy or another item is already queued.
- Queued messages can be edited or deleted until sending begins.
- Queued input is bound to the current provider thread so it cannot leak into a different run after a source change.
- The next queued item is sent automatically when the session becomes ready.

Every submitted message is persisted before delivery and bound to the current provider thread. Muxpilot records the runtime receipt and reconciles the stable client ID against authoritative thread state before any retry.

If delivery cannot be verified, the session enters `input_failed`, preserves the exact message, and blocks further composer input. **Retry input** first reconciles authoritative runtime state; **Dismiss** clears the blocking state without claiming delivery. Pending deliveries are reconciled after backend restart and transcript rollover so acknowledged input is not replayed. See [Runtime Reliability](runtime-reliability.md#verified-input-delivery).

The Normal/Plan and Fast controls use structured thread settings. If the agent is waiting for a structured question or proposed-plan decision, the general composer remains locked until that prompt is resolved.

When supported by the provider and active model, **Fast** turns on the provider's Fast mode and also updates the default for future sessions. Fast mode uses more credits. The control is hidden for providers or models without it, disabled while the session cannot accept the change, and dashboard cards show when it is active.

## Interactive gates

muxpilot exposes common agent interactions in the browser:

- Approval prompts can be approved once, approved for an offered prefix, or denied.
- Connector and tool permission prompts expose the choices supplied by the provider.
- Structured questions render as form controls.
- Multiple-choice and free-form answers are returned through the exact runtime request.
- Proposed plans can remain in plan mode or move into implementation, with or without clearing context.

Muxpilot answers these requests with their exact runtime JSON-RPC request identity. It does not bypass provider approval behavior.

## Prompt history and skills

Press `Ctrl+R` to search previously submitted user prompts. Choosing a result copies it to the clipboard.

In a Codex session, type `$` anywhere in the composer to search available Codex skills. In a Claude session, type `/` at the start of a message to search Claude skills. Suggestions may include user, system, plugin, and workspace skills; muxpilot's bundled skills are installed for Claude as a local plugin. Use Arrow Up/Down to select, `Enter` or `Tab` to accept, and `Escape` to dismiss.

## Keyboard reference

The focus and dialog shortcuts below work when focus is not inside an input, editor, menu, or dialog. `Backspace` applies only in the session view.

| Key | Action |
| --- | --- |
| `Ctrl+N` | Open the new-session dialog |
| `Ctrl+R` | Open prompt history |
| `Escape` | Close the active dialog |
| `i` | Focus the primary input |
| `I` | Focus the primary input at the start |
| `a` | Focus the primary input for append |
| `A` | Focus the primary input at the end |
| `Backspace` | Return from a session to the dashboard |
| `Ctrl+Enter` | Send or queue composer input |

On the dashboard, the primary input is search. In a session, it is the composer.

### Vim mode

Vim mode is available on desktop-like devices with keyboard and pointer support. It adds relative line numbers and Vim navigation to the composer and transcript.

| Key | Action |
| --- | --- |
| `Escape` | Leave insert/visual mode, or blur from normal mode |
| `Ctrl+W`, then `k` | Move from the composer to the transcript |
| `Ctrl+W`, then `j` | Move from the transcript to the composer |
| `gg` / `G` | Jump to the oldest / newest transcript page |
| `Ctrl+U` / `Ctrl+D` | Scroll half a page up / down |
| `Ctrl+B` / `Ctrl+F` | Scroll a full page up / down |
| `/` | Open transcript search |

## Notifications

Notification rules can be enabled globally or per session for:

- A running task returning to a ready state
- An approval, question, proposed plan, or blocked state needing attention
- Any status change

A matching rule can ring the session card, show a toast, play a sound, or send a Web Push notification. Browser subscriptions and VAPID keys are stored locally in SQLite. Notifications remain quiet during initial transcript catch-up so old activity does not trigger new alerts.

Nested-session events roll up to the owning root so the operator sees meaningful child attention without duplicate alerts for every ancestor. The dashboard still exposes each child's exact state.

## Heavyweight commands

When a managed session runs a scheduled heavyweight command, an indicator in the session header shows whether commands are queued, reserved, running, stalled, or terminating. Open it for the command and working directory, queue position or slot/PID, live bounded output, process and Docker activity, package-manager diagnostics, cache paths, deadlines, and retained log path.

The operator can terminate a command and its process group from this view. A terminated or never-started command is not a passing validation result. Queue release and automatic resume appear as structured transcript events. See [Runtime Reliability](runtime-reliability.md#heavyweight-command-scheduler).

## Phone and PWA behavior

When LAN mode is enabled, the host-only **Connect device** dialog provides detected phone URLs, the current access key, QR codes, a revoke action, and an optional unrestricted-LAN toggle. Use unrestricted access only on a trusted LAN. If HTTPS certificates are configured, the dialog also provides the public root certificate needed by the phone.

Camera-based QR login and installable PWA behavior generally require HTTPS with a trusted certificate. See the [setup guide](setup.md#phone-access-on-the-same-network) for the connection flow and platform-specific LAN documentation for firewall configuration.

An installed PWA checks for a newer web build at startup and when it returns to the foreground. A waiting build shows an update notice and reloads only after the operator accepts it. After sleep, backgrounding, or a backend restart, the app shows connecting/reconnecting state, retries automatically, and refreshes session snapshots when the connection returns.

## Session discovery

Muxpilot periodically reconciles managed session services, persisted thread identities, and recent provider session files. It tracks:

- Session service, socket, and thread identity
- Working directory
- Repository root, branch, worktree, and dirty state
- Matched provider session and JSONL file
- Transcript size and recent prompt activity
- Inferred working or attention status

When a session begins using a different JSONL source, muxpilot resets the stored transcript for that app session so events from the previous run do not appear under the new one.

## Statuses

The dashboard groups statuses into three attention colors:

- **Red:** operator attention is needed.
- **Yellow:** the agent is active or its state is uncertain.
- **Green:** the session is ready for input.

Common status labels include:

| Status | Meaning |
| --- | --- |
| `working`, `generating`, `executing` | The agent appears busy |
| `planning` | The agent is working in Plan mode |
| `queued` | Submitted or scheduled work has not started yet |
| `waiting`, `idle` | Input is likely safe to send |
| `approval` | An approval gate is open |
| `question` | A structured question is waiting |
| `plan_ready` | A proposed plan needs a choice |
| `blocked` | The agent reported a blocker |
| `input_failed` | The last submitted message is preserved but delivery needs retry or dismissal |
| `startup_failed` | A managed session could not start |
| `completed` | An agent-managed session was explicitly finished |
| `missing` | The stored runtime is stopped, unavailable, or no longer discoverable |
| `unknown` | muxpilot cannot confidently infer the state |
