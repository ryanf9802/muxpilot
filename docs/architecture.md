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

SQLite stores application state: parsed messages, parser offsets, unread counts, queued inputs, dashboard metadata, restorable-session prompt indexes, OpenAI usage estimates, events, and audit records.

Managed Git sessions store only the repository entry point, existing local target branch, dependency link candidates, and path to a skill-owned status file.

## Components

- React Web UI: operator access screen, dashboard, session transcript, composer, queued input controls, pending approval/question banners, skill suggestions, raw terminal panel, and LAN connection details.
- Fastify Backend/API server: operator access gate, REST API, WebSocket event stream.
- Session manager: discovery, pane-to-Codex mapping, parser scheduling, event publishing.
- Tmux adapter: fixed argv wrappers around `list-panes`, `capture-pane`, `send-keys`, `load-buffer`, and management commands.
- Codex parser: maps JSONL events to typed chat messages, approvals, questions, assistant progress, proposed plans, and user-context markers.
- Database adapter: local SQLite via `node:sqlite`, isolated so libSQL/Turso can be added later.
- Activity summarizer: optional OpenAI-backed, prompt-only session summaries and usage/cost recording.
- Codex usage service: optional dashboard data from `codex app-server --stdio`.
- Skill discovery: reads user, system, plugin, and workspace Codex skills for composer suggestions.
- Local Git workflow skill: creates task worktrees, links dependencies, guides focused validation and iterative self-review, serializes local fast-forward integration, and removes completed worktrees. The backend only reads its status file.

## Operator Access

Loopback-only use defaults to trusted local operator access. LAN use requires `MUXPILOT_LAN_ENABLED=1`; the backend generates a remote access key at startup and exposes it only through the host-machine Connect device modal.

The access key is submitted in the request body to `/api/access`. After success, the backend sets an HTTP-only signed cookie. The QR-code access URL may include the current generated access key, and the frontend removes it from browser history before submitting it.

Cookie signing uses an in-memory random secret by default. Restarting the backend invalidates existing browser access sessions, which is acceptable for this single-operator LAN tool. `MUXPILOT_SESSION_SECRET` is optional for operators who want cookies to survive restarts.

## Persistence

SQLite lives on the Backend/API server host under `MUXPILOT_DB_PATH`. Build output under `dist/` is disposable; persistent state such as parsed messages, usage, cost estimates, summaries, and audit events must live outside `dist/`.

Development uses `./data/dev/muxpilot.db` through `pnpm app start dev`. Production uses `./data/prod/muxpilot.db` through `pnpm app start`.

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

Session actions:

```text
React action button -> POST /api/sessions/:id/actions -> SessionManager -> TmuxAdapter/SQLite -> WebSocket session update
```

Supported actions include interrupt, input-mode switch, proposed-plan choice, rename, detach notice, kill pane, and archive transcript.

Managed Git session creation and integration:

```text
entry directory + existing local target -> neutral tmux/Codex control directory
change task -> skill creates private branch/worktree + simple dependency links -> focused checks + iterative same-agent review -> atomic local fast-forward -> cleanup
```

Task implementation is concurrent. A repository-local branch lock protects only the final local integration step. If another task lands first, the later task rebases and repeats focused validation and self-review. Conflicts and unfinished changes remain in their task worktree; dirty target checkouts are never changed. Normal workflow helpers do not pull or push.

Restorable session history:

```text
Parsed user messages -> SQLite FTS prompt index -> GET /api/session-history -> New Session History tab
History restore -> POST /api/session-history/:id/restore -> tmux new-window "codex resume <session-id>"
```

The history index contains only displayable user prompts from sessions muxpilot has managed. Assistant, tool, command, hidden environment context, and action-only user context are excluded from the index.
