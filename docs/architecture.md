# Architecture Overview

muxpilot is a lightweight developer operator console layered on top of existing tmux and Codex CLI sessions.

```text
Operator device browser -> HTTP/WebSocket -> Backend/API server -> tmux -> Codex CLI panes
                                                       |
                                                       -> Codex JSONL files
                                                       -> SQLite database
```

The Backend/API server owns all tmux communication. The browser never runs shell commands and only talks to constrained REST and WebSocket endpoints.

This iteration supports a local session host only: tmux, Codex JSONL files, and the Backend/API server run on the same host machine. Same-network phones connect to the web UI over LAN HTTP and authenticate with the backend-generated remote access key when the server is exposed beyond loopback.

## Workspace Boundaries

- `apps/server`: trusted host process and source of side effects.
- `apps/web`: browser UI and API client.
- `packages/core`: shared contracts and deterministic display helpers for code used by both apps.

`@muxpilot/core` is a separate package so the server and web app can share API types and transcript normalization without either app importing from the other app's source tree.

## Sources Of Truth

tmux is authoritative for live session existence, pane ids, cwd, window names, pane titles, and input delivery.

Codex JSONL files under `~/.codex/sessions` are the preferred transcript source because they contain structured user, assistant, and tool events. Terminal capture is used for raw view and recovery previews.

SQLite stores application state: managed-session metadata, parsed messages, parser offsets, prompt search, queued inputs and delivery state, BTW exchanges, orchestration waits and ownership, dashboard settings, notifications, summaries and usage estimates, recovery incidents, Git workspace bindings, and audit records. WebSocket events are published live and are not retained as the source of truth.

Session documents, Git worktrees, runtime logs, heavyweight-command logs, and transfer staging are filesystem state with their own bounded roots. They are not stored in SQLite or the web bundle.

Managed Git sessions store the repository entry point, current existing local target branch, dependency link candidates, skill-owned status path, control/worktree roots, and a private broker capability. The launch-time target is an initial fallback; a guard-confirmed agent retarget is persisted through the status file and observed by the backend.

## Components

- React Web UI: operator access screen, attention dashboard and agent trees, structured transcript, composer and verified-delivery recovery, queued input controls, interactive gates, documents and BTW views, Git/heavyweight controls, raw terminal panel, transfer/recovery dialogs, and LAN connection details.
- Fastify Backend/API server: operator access gate, REST API, WebSocket event stream.
- Session manager: discovery, pane-to-Codex mapping, parser scheduling, verified input delivery, queued input, crash recovery, session create/fork/restore, agent ownership, and event publishing.
- Tmux adapter: fixed argv wrappers around `list-panes`, `capture-pane`, `send-keys`, `load-buffer`, and management commands.
- Codex parser: maps JSONL events to typed chat messages, approvals, questions, assistant progress, proposed plans, and user-context markers.
- Database adapter: local SQLite via `node:sqlite`, isolated so libSQL/Turso can be added later.
- Activity summarizer: optional OpenAI-backed, prompt-only session summaries and usage/cost recording.
- Codex usage service: optional dashboard data from `codex app-server --stdio`.
- Skill discovery: reads user, system, plugin, and workspace Codex skills for composer suggestions.
- Session documents: provisions per-session Markdown storage, exposes it to Codex as an additional writable root, validates safe read-only operator access, and snapshots documents for forks and transfers.
- BTW service: forks a bounded app-server turn from a conversation snapshot, streams independent answers, coordinates isolated document staging, and hands safe changes back to the main session.
- Session orchestration broker: binds a capability-scoped MCP server to each managed Codex launch and enforces ownership, context, work-token, wait, scope, and security boundaries.
- Raw evidence reader: exposes bounded, read-only tmux, `/proc`, and Codex JSONL evidence for independent diagnosis.
- Heavy command service: observes shared queue metadata, resumes reserved sessions, serves bounded live output, and terminates exact process groups on operator request.
- Resource governor and Docker proxy: allocate muxpilot-owned systemd scopes and label/constrain containers created through managed sessions.
- Session transfer service: packages portable transcript prefixes, preferences, documents, and eligible committed Git objects with optional authenticated encryption.
- Local Git workflow skill and authenticated broker: the skill creates task worktrees, links dependencies, and guides focused validation and iterative self-review. On finish, the broker revalidates workspace ownership, clean state, target identity, and fast-forward ancestry before updating the local target and removing completed task state.

## Operator Access

Loopback-only use defaults to trusted local operator access. LAN use requires `MUXPILOT_LAN_ENABLED=1`; the backend generates a remote access key at startup and exposes it only through the host-machine Connect device modal.

The access key is submitted in the request body to `/api/access`. After success, the backend sets an HTTP-only signed cookie. The QR-code access URL may include the current generated access key, and the frontend removes it from browser history before submitting it.

Cookie signing uses an in-memory random secret by default. Restarting the backend invalidates existing browser access sessions, which is acceptable for this single-operator LAN tool. `MUXPILOT_SESSION_SECRET` is optional for operators who want cookies to survive restarts.

The browser access boundary is separate from session capabilities. A browser action is authorized as the operator; a managed Codex process receives only the Git/orchestration brokers and writable roots injected for that session. Security approvals cannot be delegated through the orchestration broker.

## Persistence

SQLite lives on the Backend/API server host under `MUXPILOT_DB_PATH`. Build output under `dist/` is disposable; persistent state such as parsed messages, usage, cost estimates, summaries, and audit events must live outside `dist/`.

Development uses `./data/dev/muxpilot.db` through `pnpm app start dev`. Production uses `./data/prod/muxpilot.db` through `pnpm app start`.

Per-session documents live below the session control root under an opaque scope ID. Managed task worktrees live below the configured worktree root. Supervisor state lives under `data/runtime/<mode>/`; heavyweight queue metadata uses its configured shared temporary directory. Transfer uploads are staged for a bounded time and removed after import, cancellation, or expiry.

## Future Work

Remote SSH session hosts, GitHub Pages/static cross-origin hosting, VPN/tunnel guidance, and internet-reachable deployments are intentionally out of scope for this LAN iteration.

## Data Flow

Dashboard:

```text
tmux list-panes + Codex session scan -> session manager -> SQLite -> GET /api/sessions -> React cards
```

Transcript:

```text
Codex JSONL appended -> parser offset read -> new events mapped -> messages stored -> WebSocket pushed
```

Input:

```text
React composer -> POST /api/sessions/:id/input -> tmux load-buffer -> paste-buffer -> short delay -> send submit keys
Busy session -> queued input stored in SQLite -> sent when the session becomes input-ready
Mode toggle -> POST /api/sessions/:id/actions -> tmux send configured mode-cycle keys
Interactive buttons -> POST /api/sessions/:id/actions or /question -> tmux menu keys
App permission form in terminal -> live approval parser -> GET/POST /approval -> verified relative tmux menu keys
```

Verified delivery:

```text
persist user message + source identity -> paste exact text -> verify composer -> submit
        -> Codex lifecycle/status acknowledgement -> mark acknowledged
        -> safe submit retry or one empty-composer replay -> mark input_failed for operator retry/dismiss
```

Session actions:

```text
React action button -> POST /api/sessions/:id/actions -> SessionManager -> TmuxAdapter/SQLite -> WebSocket session update
```

Supported actions include interrupt, input-mode switch, proposed-plan choice, rename, detach notice, kill pane, and archive transcript.

BTW and documents:

```text
question + main Codex thread snapshot -> independent bounded app-server turn -> streamed BTW history
document request -> isolated staging copy -> validate diff + safe-boundary check -> atomic apply -> private main-session notice
```

Agent orchestration:

```text
capability-bound MCP call -> ownership/scope/context/budget validation -> SessionManager action
create child -> fresh Codex/tmux session + private scope/documents + inherited repo/target/settings -> initial task
wait -> durable SQLite record -> out-of-model event watch -> exact parent resume message
```

Managed Git session creation and integration:

```text
entry directory + existing local target -> neutral tmux/Codex control directory + repository skill links
change task -> skill creates private branch/worktree + simple dependency links -> focused checks + iterative same-agent review -> atomic local fast-forward -> cleanup
```

Task implementation is concurrent. A per-session operation lock serializes begin, retarget, and finalize actions, while a repository-local branch lock protects the final local integration step across sessions. If another task lands first, or an active task is retargeted, the task rebases when necessary and repeats focused validation and self-review. Conflicts and unfinished changes remain in their task worktree; dirty target checkouts are never changed. Normal workflow helpers do not pull or push.

Heavyweight command continuation:

```text
task helper -> shared FIFO lease
busy -> QUEUED_NOT_RUN + released Codex turn -> muxpilot reservation -> exact automatic resume
running -> process/output/container observation -> session UI -> completion or operator process-group termination
```

Restorable session history:

```text
Parsed user messages -> SQLite FTS prompt index -> GET /api/session-history -> New Session History tab
History restore -> POST /api/session-history/:id/restore -> tmux new-window "codex resume <session-id>"
```

The history index contains only displayable user prompts from sessions muxpilot has managed. Assistant, tool, command, hidden environment context, and action-only user context are excluded from the index.

Crash recovery:

```text
open non-archived panes snapshot -> unclean restart -> compare current tmux panes
missing candidates -> operator recovery dialog -> codex resume -> restore muxpilot metadata/documents/Git binding
```

Session transfer:

```text
selected portable sessions -> manifest + transcript prefixes + documents + eligible Git bundle
    -> optional AES-GCM archive -> destination mapping/branch inspection -> safe import + Codex resume
```

For deeper contracts, see [Local Git Workflow](git-workflow.md), [Agent Orchestration](agent-orchestration.md), and [Runtime Reliability](runtime-reliability.md).
