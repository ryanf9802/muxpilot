# Architecture Overview

muxpilot is a lightweight developer operator console for durable Codex and Claude sessions. Each session belongs to one provider: Codex runs on Codex app-server, and Claude runs on Claude Code through the Claude Agent SDK.

```text
Operator browser -> HTTP/WebSocket -> Backend/API server -> provider registry -> semantic session driver
                                                       |-> Codex app-server + systemd service
                                                       |-> Claude session host + systemd service
                                                       |-> Codex or Claude JSONL evidence
                                                       `-> SQLite database
```

The Backend/API server owns the runtime integration. The browser uses semantic actions and never shell primitives.

This iteration supports a local session host only: runtime services, provider files, and the Backend/API server run on the same host machine. Same-network phones connect to the web UI over LAN HTTP and authenticate with the backend-generated remote access key when the server is exposed beyond loopback.

## Workspace Boundaries

- `apps/server`: trusted host process and source of side effects. Provider integrations live in `src/providers/` (`codex/`, `claude/`, and `shared/`, behind the contracts in `types.ts` and `registry.ts`); provider-neutral systemd supervision, JSON-RPC connections, and protocol journals live in `src/runtime/`.
- `apps/web`: browser UI and API client.
- `packages/core`: shared contracts and deterministic display helpers for code used by both apps.

`@muxpilot/core` is a separate package so the server and web app can share API types and transcript normalization without either app importing from the other app's source tree.

## Sources Of Truth

Provider/thread identity, reconciled provider protocol state (Codex app-server or Claude host), and the muxpilot-owned systemd unit and socket are authoritative for live sessions.

Provider JSONL files are the durable transcript source because they contain structured user, assistant, and tool events: Codex writes them under `~/.codex/sessions`, and Claude Code writes them to `<CLAUDE_CONFIG_DIR>/projects/<project-slug>/<session-id>.jsonl`, with each session's subagent transcripts and tool results under `<session-id>/`. Claude Code deletes these after its `cleanupPeriodDays` (30 days by default), and any Claude process on the host does the sweep. So muxpilot mirrors every Claude transcript and its session directory into `<MUXPILOT_DATA_DIR>/claude-archive/<session-id>/` and restores missing copies before resuming, forking, answering BTW, reviewing approvals, reconciling input, or exporting a session.

SQLite stores application state: managed-session metadata, parsed messages, parser offsets, prompt search, queued inputs and delivery state, BTW exchanges, orchestration waits and ownership, dashboard settings, notifications, recovery incidents, Git workspace bindings, and audit records. WebSocket events are published live and are not retained as the source of truth.

Session documents, Git worktrees, runtime logs, heavyweight-command logs, and transfer staging are filesystem state with their own bounded roots. They are not stored in SQLite or the web bundle.

Managed Git sessions store the repository entry point, current existing local target branch, dependency link candidates, skill-owned status path, control/worktree roots, and a private broker capability. The launch-time target is an initial fallback; a guard-confirmed agent retarget is persisted through the status file and observed by the backend.

## Native Versus muxpilot-Owned Features

For Claude sessions, muxpilot drives Claude Code's native features and makes them visible instead of re-implementing them:

| Owner | Features |
| --- | --- |
| Claude Code, passed through | Subagents and background agents, workflows, compaction, memory, hooks, plugins, skills and slash commands, output styles, user permission rules, the sandbox, task checklists, cross-session messaging, scheduled wakeups and cron jobs, self-entered plan mode, the auto-approval classifier |
| Claude Code engine with a muxpilot view | The Agents view (status, transcript, stop), approvals naming the requesting subagent, plan-mode state |
| muxpilot | Documents, database history and the transcript archive, BTW, approval routing and notifications, usage dashboards, transfer, Git workflow and heavyweight queue, hibernation and resource scopes, child sessions (on explicit request or for a different provider) |

Claude Code's worktree tools, remote triggers, and push notifications stay disabled, because muxpilot's Git workflow and notification routing own those jobs.

## Components

- React Web UI: operator access screen, attention dashboard and agent trees, structured transcript, composer and verified-delivery recovery, queued input controls, interactive gates, documents and BTW views, Git/heavyweight controls, transfer/recovery dialogs, and LAN connection details.
- Fastify Backend/API server: operator access gate, REST API, WebSocket event stream. `/api/providers` lists enabled providers with compatibility, capabilities, and sign-in state, and `PATCH /api/providers/default` persists the default provider. Provider-scoped routes under `/api/providers/:kind/` serve authentication state and refresh, usage summary and history, Codex usage-reset redemption, models, model defaults, approval-reviewer settings, and skills.
- Session manager: structured reconciliation, verified input, queues, hibernation/recovery, create/fork/restore, agent ownership, and event publishing.
- Provider registry: routes each session to its enabled provider by kind and supplies that provider's driver, compatibility probe, authentication lifecycle, usage, models, skills, transcript parser, approval reviewer, and BTW engine.
- Approval reviewer: evaluates Auto-mode runtime requests with the session's provider in an isolated context, a read-only Codex thread or a tool-less Claude query, and returns structured decisions or escalations.
- Codex app-server driver: semantic lifecycle/input/gate/settings operations, durable per-session services and sockets, compatibility checks, protocol journals, and exact-thread reconnect/read barriers.
- Claude driver and session host: each Claude session runs a muxpilot host process as a muxpilot-owned user service. The host holds one streaming Claude Agent SDK query, speaks JSON-RPC to the backend over a private Unix socket, applies muxpilot's tool permission policy, and holds interactive requests while the backend is disconnected. Claude Code's sandbox (bubblewrap and socat) is mandatory; without it the provider reports `sandbox_unavailable`.
  - The host maps muxpilot's modes to Claude permission modes. Normal is `acceptEdits`, Plan is `plan`, and Normal with Auto approval is Claude's native `auto` classifier, falling back to `acceptEdits` plus muxpilot's reviewer. It reports mode changes Claude makes itself.
  - It tracks Claude Code's tasks (subagents, background shells, monitors, workflows) from `task_*` events, with progress summaries, and pushes `agents/changed`.
  - It tracks pending `ScheduleWakeup` and cron jobs, which block hibernation.
  - Session routes `GET /api/sessions/:id/agents`, `GET /api/sessions/:id/agents/:agentId/messages` (read from the subagent's own transcript), and `POST /api/sessions/:id/agents/:agentId/stop` back the Agents view.
- Provider authentication lifecycle: observes each provider's CLI-managed login (`codex login`, `claude auth login`) and credential files independently, holds session admission during an account change, and suspends or restarts that provider's live sessions at safe boundaries.
- Transcript parsers: map Codex or Claude JSONL events to typed chat messages, approvals, questions, assistant progress, proposed plans, and user-context markers.
- Database adapter: local SQLite via `node:sqlite`, isolated so libSQL/Turso can be added later.
- Usage services: per-provider dashboard data, from `codex app-server --stdio` for Codex and from an idle Claude SDK control session, live rate-limit events, and Claude transcripts for Claude.
- Skill discovery: reads each provider's user, system, plugin, and workspace skills for composer suggestions. Bundled muxpilot skills are installed into the Codex home and, for Claude, as a local plugin under the muxpilot data directory.
- Session documents: provisions per-session Markdown storage, exposes it to the agent as an additional writable root, validates safe read-only operator access, and snapshots documents for forks and transfers.
- BTW service: runs a provider-specific BTW engine, a bounded app-server turn or an unpersisted Claude conversation fork, from a conversation snapshot, streams independent answers, coordinates isolated document staging, and hands safe changes back to the main session.
- Session orchestration broker: binds a capability-scoped MCP server to each managed session launch and enforces ownership, context, work-token, wait, scope, and security boundaries.
- Heavy command service: observes shared queue metadata, resumes reserved sessions, serves bounded live output, and terminates exact process groups on operator request.
- Resource governor and Docker proxy: allocate muxpilot-owned systemd scopes and label/constrain containers created through managed sessions.
- Session transfer service: packages portable transcript prefixes, preferences, documents, encrypted session variables, and eligible committed Git objects with passphrase-based authenticated encryption.
- Local Git workflow skill and authenticated broker: the skill creates task worktrees, links dependencies, and guides focused validation and iterative self-review. On finish, the broker revalidates workspace ownership, clean state, target identity, and fast-forward ancestry before updating the local target and removing completed task state.

## Operator Access

Loopback-only use defaults to trusted local operator access. LAN use requires `MUXPILOT_LAN_ENABLED=1`; the backend generates a remote access key at startup and exposes it only through the host-machine Connect device modal.

The access key is submitted in the request body to `/api/access`. After success, the backend sets an HTTP-only signed cookie. The QR-code access URL may include the current generated access key, and the frontend removes it from browser history before submitting it.

Cookie signing uses an in-memory random secret by default. Restarting the backend invalidates existing browser access sessions, which is acceptable for this single-operator LAN tool. `MUXPILOT_SESSION_SECRET` is optional for operators who want cookies to survive restarts.

The browser access boundary is separate from session capabilities. A browser action is authorized as the operator; a managed agent process receives only the Git/orchestration brokers and writable roots injected for that session. Runtime approval automation is selected by the operator per session and cannot be elevated through the orchestration broker.

## Persistence

SQLite lives on the Backend/API server host under `MUXPILOT_DB_PATH`. Build output under `dist/` is disposable; persistent state such as parsed messages, session settings, provider usage snapshots, and audit events must live outside `dist/`.

Development uses `./data/dev/muxpilot.db` through `pnpm app start dev`. Production uses `./data/prod/muxpilot.db` through `pnpm app start`.

Per-session documents live below the session control root under an opaque scope ID. Managed task worktrees live below the configured worktree root. Supervisor state lives under `data/runtime/<mode>/`; heavyweight queue metadata uses its configured shared temporary directory. Transfer uploads are staged for a bounded time and removed after import, cancellation, or expiry.

## Future Work

Remote SSH session hosts, GitHub Pages/static cross-origin hosting, VPN/tunnel guidance, and internet-reachable deployments are intentionally out of scope for this LAN iteration.

## Data Flow

Dashboard:

```text
provider runtime evidence + transcript scan -> session manager -> SQLite -> API -> React
```

Transcript:

```text
provider JSONL appended -> parser offset read -> new events mapped -> messages stored -> WebSocket pushed
```

Input:

```text
React composer -> persist stable client ID -> driver.sendMessage -> turn/start
Busy turn + Steer now -> persist stable client ID -> driver.steer -> turn/steer
Busy session -> queued input in SQLite -> wake if hibernated -> send when ready
Mode/Fast toggle -> driver.setPreferences -> provider settings update
Interactive gate -> persisted exact request ID -> structured JSON-RPC response
```

Active turns expose separate **Steer now** and **Queue** actions. A definitive stale or non-steerable response moves the same persisted submission into the normal queue; an uncertain response is reconciled by client message ID before any retry or fallback.

Verified delivery:

```text
persist user message + provider/thread/client identity -> structured send -> exact receipt/item acknowledgement
uncertain delivery -> authoritative thread read -> reconcile stable client ID before any retry
```

Session actions:

```text
React action button -> POST /api/sessions/:id/actions -> SessionManager -> provider driver/SQLite -> WebSocket update
```

Supported actions include interrupt, settings, proposed-plan choice, rename, hibernate/wake, detach notice, runtime kill, and archive transcript.

BTW and documents:

```text
question + main conversation snapshot -> independent bounded provider turn -> streamed BTW history
document request -> isolated staging copy -> validate diff + safe-boundary check -> atomic apply -> private main-session notice
```

Agent orchestration:

```text
capability-bound MCP call -> ownership/scope/context/budget validation -> SessionManager action
create child -> fresh session on the parent's or requested provider + private resource/documents + inherited repo/target/settings -> initial task
wait -> durable SQLite record -> out-of-model event watch -> exact parent resume message
```

Managed Git session creation and integration:

```text
change task -> skill creates private branch/worktree + simple dependency links -> focused checks + iterative same-agent review -> atomic local fast-forward -> cleanup
```

Task implementation is concurrent. A per-session operation lock serializes begin, retarget, and finalize actions, while a repository-local branch lock protects the final local integration step across sessions. If another task lands first, or an active task is retargeted, the task rebases when necessary and repeats focused validation and self-review. Conflicts and unfinished changes remain in their task worktree; dirty target checkouts are never changed. Normal workflow helpers do not pull or push.

Heavyweight command continuation:

```text
task helper -> shared FIFO lease
busy -> QUEUED_NOT_RUN + released agent turn -> muxpilot reservation -> exact automatic resume
running -> process/output/container observation -> session UI -> completion or operator process-group termination
```

Restorable session history:

```text
Parsed user messages -> SQLite FTS prompt index -> GET /api/session-history -> New Session History tab
```

The history index contains only displayable user prompts from sessions muxpilot has managed. Assistant, tool, command, hidden environment context, and action-only user context are excluded from the index.

Crash recovery:

```text
missing candidates -> operator recovery dialog -> provider resume -> restore muxpilot metadata/documents/Git binding
```

Session transfer:

```text
selected portable sessions -> manifest + transcript prefixes + documents + eligible Git bundle
    -> optional AES-GCM archive -> destination mapping/branch inspection -> safe import + provider resume
```

For deeper contracts, see [Local Git Workflow](git-workflow.md), [Agent Orchestration](agent-orchestration.md), and [Runtime Reliability](runtime-reliability.md).
