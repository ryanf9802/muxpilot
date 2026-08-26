# Usage Guide

muxpilot is an operator console for Codex CLI sessions running in tmux. This guide covers the session workflows and controls available after [setup](setup.md).

## Dashboard

The dashboard groups sessions by repository and makes their attention state visible at a glance. Session cards can show:

- Current status and attention color
- Repository, branch, working directory, and dirty-worktree state
- Recent user prompts and optional activity summaries
- Transcript size and tmux metadata
- OpenAI usage estimates when configured
- Codex account and rate-limit information when available

Search matches repository names, branches, working directories, tmux metadata, session previews, summaries, and recent prompts. Use a session's action menu to rename it, configure notifications, fork it, or terminate its pane.

## Session view

Opening a session shows its structured Codex transcript. muxpilot keeps user prompts, assistant responses, approvals, questions, proposed plans, aborts, and other important events visible while collapsing noisier tool activity and command output.

The session view also provides:

- Expandable activity groups and transcript ranges
- Normal and Plan input modes
- Queue-aware input with editable pending messages
- Inline approval, question, and proposed-plan controls
- Prompt skill suggestions and optional Vim composer mode
- Transcript search, paging, and jump controls
- Raw terminal capture and a copyable local tmux attach command
- Interrupt, fork, new-session, and kill actions

## Creating sessions

Open the new-session dialog or press `Ctrl+N`.

The Create tab asks for:

- **Directory:** the repository or working directory in which Codex should start
- **Name:** the tmux window name for the session
- **Target branch:** an existing local branch used as the integration destination for managed Git work

Directory suggestions come from active sessions and recently touched repositories. Names are normalized to 2–32 lowercase letters, numbers, or hyphens.

New sessions run in the shared tmux session named `muxpilot`. Existing Codex panes can also be discovered when muxpilot can match them to local Codex session logs.

### Managed Git sessions

For a Git repository, muxpilot starts Codex from a neutral control directory and makes applicable repository skills available there. The bundled Git workflow creates a short-lived task worktree only when a change is needed.

The workflow:

1. Isolates repository writes in a task worktree.
2. Links existing dependency directories where safe.
3. Runs focused validation and iterative self-review.
4. Creates atomic commits.
5. Rebases when the target advances and repeats affected checks.
6. Locally fast-forwards the selected target branch after final validation.
7. Removes the completed task worktree and temporary branch.

The target branch must already exist locally. Selecting or creating a different implementation branch requires explicit confirmation because current and future task commits will integrate there. muxpilot does not automatically fetch, pull, push, or publish changes. A dirty target checkout blocks integration.

Heavy validation—such as repository-wide checks, production builds, scanners, Docker workloads, or multi-worker tests—uses a shared resource lease. That scheduler controls concurrency but does not authorize broader validation than the user requested.

Externally discovered Codex panes remain unmanaged because a running process cannot safely be moved into a managed workspace. For change tasks, a direct Codex session running in tmux can initialize the bundled Git workflow's standalone mode after the user explicitly approves an existing local target branch. Standalone mode provides short-lived worktrees, dependency reuse, target locking, rebase/re-review gates, local integration, and cleanup, but it does not retrofit muxpilot workspace controls, sandbox roots, developer instructions, authenticated broker integration, or deferred heavyweight-command continuation. Non-Git directories keep the direct-directory session flow.

## Restoring sessions

The History tab in the new-session dialog searches sessions previously managed by muxpilot. Search covers submitted user prompts, not assistant messages or tool output.

Selecting a live result opens its existing pane. Selecting a missing or archived result starts a new tmux window with Codex's native resume command and opens the restored session.

If muxpilot stops without a clean shutdown, it records which non-archived Codex panes were open. On the next startup, any of those panes that are now missing appear together in a recovery dialog. All candidates are selected by default, so they can be reopened in one batch or reviewed first. Choosing **Not now** dismisses the batch; each conversation remains available from History.

Recovery restores the durable Codex conversation, muxpilot metadata, and any managed Git workspace binding. It cannot recreate an operating-system process or automatically restart a command that was executing when WSL, tmux, or the host stopped.

## Forking sessions

Use **Fork session** from the session header or dashboard action menu to branch a conversation at its current persisted tip. The child retains a **Forked from** link while the source remains available locally.

Forking is allowed while the source is working, but Codex may record its partial turn as interrupted. Queued inputs, composer drafts, pins, notifications, and other transient UI state are not copied.

A fork of a managed Git session inherits the same target branch but receives its own managed workspace. Unintegrated files from the source worktree are not copied; the fork starts from the current target branch.

## Agent delegation

Routine bounded delegation, including standard code-review passes, uses Codex's built-in subagents and does not create nested muxpilot sessions. If built-in subagents are unavailable, the review remains in the current session.

Nested muxpilot sessions are reserved for work the operator explicitly requests as a separate session or durable delegated work that benefits from independent monitoring and its own resource scope. Those sessions remain visible in muxpilot and use the session-orchestration lifecycle and resource guardrails.

## Moving sessions between hosts

The transfer dialog exports one or more sessions to a `.mpsession` archive. On the destination host, map each source repository or directory to its new path and import the archive. muxpilot restores Codex transcripts and portable session preferences, then resumes the imported sessions in tmux.

For managed Git sessions, current exports can include the committed local target branch and objects not available from its upstream. Import may create, reuse, or safely fast-forward the same branch name. It never fetches, pulls, pushes, overwrites divergent history, or replaces a conflicting upstream.

Transfer archives do not contain dirty files, staged or untracked changes, stashes, active worktrees, dependencies, Git LFS payloads, submodule repositories, queued input, notification rules, machine-wide Codex configuration, or live processes. Copy or clone the repositories separately.

Set the same `MUXPILOT_SESSION_FILE_KEY` value on both hosts to encrypt exports and decrypt imports. Plaintext archives remain importable when a key is configured.

## Sending and queuing input

muxpilot sends text through a tmux paste buffer, followed by the configured submit key sequence.

- `Ctrl+Enter` submits the composer.
- Input is sent immediately when Codex is ready.
- Input is queued while Codex is busy or another item is already queued.
- Queued messages can be edited or deleted until sending begins.
- Queued input is bound to the current Codex transcript source so it cannot leak into a different run after a pane or source change.
- The next queued item is sent automatically when the pane becomes ready.

The Normal/Plan toggle changes Codex collaboration mode through the configured tmux key sequence. If Codex is waiting for a structured question or proposed-plan decision, the general composer remains locked until that prompt is resolved.

## Interactive gates

muxpilot exposes common Codex interactions in the browser:

- Approval prompts can be approved once, approved for an offered prefix, or denied.
- Connector permission prompts expose the choices supplied by Codex.
- Structured questions render as form controls.
- Multiple-choice answers follow the Codex terminal menu path.
- Free-form answers are pasted into the pane.
- Proposed plans can remain in plan mode or move into implementation, with or without clearing context.

These actions automate the same tmux input path an operator would use in the terminal. muxpilot does not bypass Codex approval behavior.

## Prompt history and skills

Press `Ctrl+R` to search previously submitted user prompts. Choosing a result copies it to the clipboard.

Type `$` in the composer to search available Codex skills. Suggestions may include user, system, plugin, and workspace skills. Use Arrow Up/Down to select, `Enter` or `Tab` to accept, and `Escape` to dismiss.

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

## Phone and PWA behavior

When LAN mode is enabled, the host-only **Connect device** dialog provides detected phone URLs, the current access key, QR codes, a revoke action, and an optional unrestricted-LAN toggle. Use unrestricted access only on a trusted LAN. If HTTPS certificates are configured, the dialog also provides the public root certificate needed by the phone.

Camera-based QR login and installable PWA behavior generally require HTTPS with a trusted certificate. See the [setup guide](setup.md#phone-access-on-the-same-network) for the connection flow and platform-specific LAN documentation for firewall configuration.

## Session discovery

muxpilot periodically reads tmux panes and recent Codex session files. For each session it tracks:

- tmux session, window, and pane identifiers
- Working directory and current command
- Repository root, branch, worktree, and dirty state
- Matched Codex session and JSONL file
- Transcript size and recent prompt activity
- Inferred working or attention status

When a pane begins using a different Codex JSONL source, muxpilot resets the stored transcript for that app session so events from the previous run do not appear under the new one.

## Statuses

The dashboard groups statuses into three attention colors:

- **Red:** operator attention is needed.
- **Yellow:** Codex is active or its state is uncertain.
- **Green:** the session is ready for input.

Common status labels include:

| Status | Meaning |
| --- | --- |
| `working`, `generating`, `executing` | Codex appears busy |
| `planning` | Codex is working in Plan mode |
| `waiting`, `idle` | Input is likely safe to send |
| `approval` | An approval gate is open |
| `question` | A structured question is waiting |
| `plan_ready` | A proposed plan needs a choice |
| `blocked` | Codex reported a blocker |
| `startup_failed` | A managed session could not start |
| `missing` | The tmux pane is no longer discoverable |
| `unknown` | muxpilot cannot confidently infer the state |
