# Architecture Overview

muxpilot is a lightweight developer operator console for durable Codex sessions. Codex app-server is the default runtime; tmux is a legacy adapter rather than the application architecture.

```text
Operator browser -> HTTP/WebSocket -> Backend/API server -> semantic session driver
                                                       |-> Codex app-server + systemd service
                                                       |-> legacy tmux + Codex CLI pane
                                                       |-> Codex JSONL evidence
                                                       `-> SQLite database
```

The Backend/API server owns every runtime adapter. The browser uses provider-neutral actions and never shell primitives.

This iteration supports a local session host only: runtime services or panes, Codex files, and the Backend/API server run on the same host machine. Same-network phones connect to the web UI over LAN HTTP and authenticate with the backend-generated remote access key when the server is exposed beyond loopback.

## Workspace Boundaries

- `apps/server`: trusted host process and source of side effects.
- `apps/web`: browser UI and API client.
- `packages/core`: shared contracts and deterministic display helpers for code used by both apps.

`@muxpilot/core` is a separate package so the server and web app can share API types and transcript normalization without either app importing from the other app's source tree.

## Sources Of Truth

For app-server sessions, the provider/thread identity, reconciled protocol snapshot, and muxpilot-owned systemd unit/socket are authoritative. For legacy sessions, tmux remains authoritative for pane existence and terminal transport.

Codex JSONL files under `~/.codex/sessions` are the preferred transcript source because they contain structured user, assistant, and tool events. Terminal capture is used for raw view and recovery previews.

SQLite stores application state: managed-session metadata, parsed messages, parser offsets, prompt search, queued inputs and delivery state, BTW exchanges, orchestration waits and ownership, dashboard settings, notifications, summaries and usage estimates, recovery incidents, Git workspace bindings, and audit records. WebSocket events are published live and are not retained as the source of truth.

Session documents, Git worktrees, runtime logs, heavyweight-command logs, and transfer staging are filesystem state with their own bounded roots. They are not stored in SQLite or the web bundle.

Managed Git sessions store the repository entry point, current existing local target branch, dependency link candidates, skill-owned status path, control/worktree roots, and a private broker capability. The launch-time target is an initial fallback; a guard-confirmed agent retarget is persisted through the status file and observed by the backend.

## Components

- React Web UI: operator access screen, attention dashboard and agent trees, structured transcript, composer and verified-delivery recovery, queued input controls, interactive gates, documents and BTW views, Git/heavyweight controls, transfer/recovery dialogs, and LAN connection details.
- Fastify Backend/API server: operator access gate, REST API, WebSocket event stream.
- Session manager: provider-neutral dispatch, legacy discovery, structured reconciliation, verified input, queues, hibernation/recovery, create/fork/restore, agent ownership, and event publishing.
- Session driver registry and Codex app-server driver: semantic lifecycle/input/gate/settings operations, durable per-session services and sockets, compatibility checks, protocol journals, and exact-thread reconnect/read barriers.
- Tmux adapter: fixed argv wrappers around `list-panes`, `capture-pane`, `send-keys`, `load-buffer`, and management commands.
- Codex parser: maps JSONL events to typed chat messages, approvals, questions, assistant progress, proposed plans, and user-context markers.
- Database adapter: local SQLite via `node:sqlite`, isolated so libSQL/Turso can be added later.
- Activity summarizer: optional OpenAI-backed, prompt-only session summaries and usage/cost recording.
- Codex usage service: optional dashboard data from `codex app-server --stdio`.
- Skill discovery: reads user, system, plugin, and workspace Codex skills for composer suggestions.
- Session documents: provisions per-session Markdown storage, exposes it to Codex as an additional writable root, validates safe read-only operator access, and snapshots documents for forks and transfers.
- BTW service: forks a bounded app-server turn from a conversation snapshot, streams independent answers, coordinates isolated document staging, and hands safe changes back to the main session.
- Session orchestration broker: binds a capability-scoped MCP server to each managed Codex launch and enforces ownership, context, work-token, wait, scope, and security boundaries.
- Raw evidence reader: exposes bounded, read-only runtime/service, process-tree, protocol-journal, tmux, and Codex JSONL evidence through the session orchestration MCP for independent diagnosis.
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
driver runtime evidence + legacy discovery + Codex scan -> session manager -> SQLite -> API -> React
```

Transcript:

```text
Codex JSONL appended -> parser offset read -> new events mapped -> messages stored -> WebSocket pushed
```

Input:

```text
React composer -> persist stable client ID -> driver.sendMessage -> turn/start
Busy app-server turn + Steer now -> persist stable client ID -> driver.steer -> turn/steer
Busy session -> queued input in SQLite -> wake if hibernated -> send when ready
Mode/Fast toggle -> driver.setPreferences -> thread/settings/update
Interactive gate -> persisted exact request ID -> structured JSON-RPC response
Legacy tmux sessions retain verified paste/menu-key behavior behind the tmux adapter
```

Active app-server turns expose separate **Steer now** and **Queue** actions. A definitive stale or non-steerable response moves the same persisted submission into the normal queue; an uncertain response is reconciled by client message ID before any retry or fallback.

Verified delivery:

```text
persist user message + provider/thread/client identity -> structured send -> exact receipt/item acknowledgement
uncertain app-server delivery -> thread/read -> reconcile stable client ID before any retry
legacy tmux -> verify composer/paste/submit/ack -> bounded safe retry
```

Session actions:

```text
React action button -> POST /api/sessions/:id/actions -> SessionManager -> selected driver/SQLite -> WebSocket update
```

Supported actions include interrupt, settings, proposed-plan choice, rename, hibernate/wake, detach notice, runtime kill, and archive transcript.

BTW and documents:

```text
question + main Codex thread snapshot -> independent bounded app-server turn -> streamed BTW history
document request -> isolated staging copy -> validate diff + safe-boundary check -> atomic apply -> private main-session notice
```

Agent orchestration:

```text
capability-bound MCP call -> ownership/scope/context/budget validation -> SessionManager action
create child -> fresh Codex session using the parent driver + private resource/documents + inherited repo/target/settings -> initial task
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
History restore -> POST /api/session-history/:id/restore -> exact-thread app-server resume by default, or explicit legacy tmux resume
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
