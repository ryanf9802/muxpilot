# Runtime Reliability Reference


## Supervised Application Lifecycle

`pnpm app start [prod|dev|shadow]` builds or starts the selected lane, launches a background supervisor, and waits for the backend and web endpoints to become healthy. The supervisor owns the server and web child processes and restarts either one after an unexpected exit.


Stop and restart terminate tracked descendants and process groups, not only the parent package-manager PID. This prevents Vite, `tsx watch`, or other children from retaining listeners after the supervisor exits.

See [Setup](setup.md), [Deployment](deployment.md), and [Configuration](configuration.md) for commands and paths.

## Managed Codex Launches

muxpilot launches new, resumed, and forked Codex sessions as muxpilot-owned app-server user services. Each launch applies the requested collaboration and model settings, provisions a private Unix socket, and injects only the capability-bound MCP servers needed by the session. The service and its cgroup own the complete process tree.

## Runtime and Transcript Reconciliation


At startup muxpilot reconnects persisted app-server services and thread identities, then catches up transcript history in the background with recent JSONL files first. Notifications start only after catch-up establishes a quiet baseline, preventing old status transitions from producing a burst of alerts.

Runtime reconciliation and parsing continue independently. The parser persists byte offsets and can make multiple bounded passes over a growing transcript. When a session binds to a different Codex JSONL source, muxpilot changes the source identity and resets the displayed transcript instead of mixing two conversations.

Initializing sessions remain visible while Codex reaches its ready screen. Live WebSocket events update the dashboard immediately, while periodic reconciliation repairs missed or stale client state.

## Verified Input Delivery

Operator and agent messages are persisted before runtime delivery begins. A submission records the destination provider/thread identity, collaboration mode, prompt hash and length, attempt counters, actor, and delivery phase.

Delivery then follows a guarded state machine:

1. Send the structured request with a stable client message ID and exact provider/thread identity.
2. Persist the app-server receipt and associated turn identity.
3. Reconcile uncertain transport outcomes with `thread/read` before attempting any retry.
4. Stop with `input_failed` rather than guessing when acknowledgement cannot be established.

While an ordinary app-server turn is active, the composer can steer that exact turn with `turn/steer`. The driver supplies its tracked active turn as the `expectedTurnId` precondition. A definitive completed, changed, or non-steerable turn response converts the same durable submission into an ordinary queued input. Transport-uncertain steering is reconciled by stable client message ID and is never blindly queued or resent.

An input failure blocks new composer messages. The session view preserves the exact submitted message and exposes **Retry input** and **Dismiss**. Retry first reconciles the stable client message ID against authoritative app-server state. Dismiss clears the blocking state without claiming that Codex received the message.

Pending deliveries are reconciled after backend restart, service reconnection, transcript rollover, and queued-input processing. A matching Codex lifecycle event marks the persisted submission acknowledged; a completed restored delivery is not sent again.

## Queued Input

Input is queued when Codex is busy or another item is already queued. The queue is persisted in SQLite and bound to the current Codex transcript source. Operators can edit the text or collaboration mode, or delete the item, until delivery begins.

Only one queued item is processed at a time. It advances when app-server reports a ready session and no unresolved interactive gate or failed delivery remains. A source change prevents queued text from leaking into a different Codex run.

## Crash Session Recovery

Before shutdown, muxpilot records the non-archived app-server sessions expected to remain available. After an unclean restart, stopped or missing services become recovery candidates. Restoring a candidate resumes its exact Codex thread through a new app-server service while retaining muxpilot metadata, documents, and managed Git bindings.


Eligible idle app-server sessions hibernate after 15 minutes by default. Pending input, interactive gates, BTW/document work, orchestration waits, heavyweight work, active turns, and background terminals block hibernation. Manual Hibernate uses the same checks; Wake and new input resume the same thread. Hibernated services retain green idle status and have no live service or child process.

## Heavyweight Command Scheduler

Managed Git sessions share a FIFO scheduler for expensive tests, scans, builds, and Docker workloads. Active commands move through `waiting`, `reserved`, `running`, `stalled`, `terminating`, and `reporting` states.

When all slots are busy, the wrapper reports `QUEUED_NOT_RUN` and ends the agent turn. muxpilot holds the ticket outside the model, reserves a slot when available, and resumes the session with an exact claim command. Queue time does not consume runtime or inactivity deadlines. An interrupted or expired reservation does not count as a test failure because the original command never ran.

Once a managed command starts, the helper asks muxpilot's host-side launch broker to create a transient user-systemd service that survives the model tool scope. The authenticated request crosses a mode-0600 Unix socket and contains only validated run metadata; its runtime-scoped broker capability is also mode 0600. The launch environment travels directly from launcher to worker over a separate private socket rather than command-line arguments or a persisted environment file. Muxpilot watches the persisted run outside the model and resumes the agent when the worker exits. Successful completions contain only the outcome, duration, exit metadata, command, and retained-log path. Failures and terminations also include a bounded diagnostic tail; fuller output stays in the private capped log. Standalone workflow helpers, and installations without managed user-systemd scopes, remain synchronous because they have no safe continuation channel.

The helper refreshes both the run record and its slot lease. If heartbeat or control-socket responses are delayed under resource pressure, muxpilot keeps the command `running` (shown internally as `stalled`) while its exact wrapper PID remains in the recorded systemd unit; a failed socket probe alone never frees the slot. When process evidence is unavailable, the lease remains protected until its configured stale interval expires. The server also enforces the absolute runtime plus termination-grace deadline independently: it rechecks ownership, stops only the recorded unit, releases only the matching slot, and reports a terminated completion with exit code 124. A failed unit stop leaves the command and slot active for a later retry.

New operator messages are held while a run is waiting or reserved, and while a resumed command is active. If an operator interrupt ends the deferred phase, the held message is delivered normally and any later resume request for that run is stale; the agent must not replay the abandoned command on its own.

Operator interrupt treats deferred-command cancellation and Codex turn interruption as independent outcomes. An already-completed Codex turn is an idempotent success, while genuine protocol failures remain visible and are audited alongside whether heavyweight cancellation was requested. When a command becomes inactive, muxpilot clears its projected activity status only after current thread, interaction, terminal, input-delivery, and queue evidence all confirm that no newer work owns the session. The same evidence-based repair runs after scheduler restart and before authentication reconciliation can treat a projected activity status as a global safe-boundary blocker.

The session header indicator opens an operator view containing:

- Command, working directory, state, slot, PID, and queue position.
- Live bounded output and retained log path.
- Output silence, observed processes, CPU/I/O activity, and labeled containers.
- Inactivity, runtime, and termination deadlines.
- Declared/resolved package manager, store path, cache paths, and warnings.

The operator can terminate a command and its process group from that view. Termination is explicit and does not mark the underlying validation successful.

See [Local Git Workflow](git-workflow.md#validation-and-heavyweight-commands) for classification and agent behavior.

## Session Resource Controls

With the resource governor enabled, busy sessions share configurable memory and CPU pools. The pool is divided across sessions in initializing, working, generating, executing, planning, or unknown states. An executor remains busy while its transient heavyweight worker owns a process; the governor applies the same allocation to that private worker unit, while an orchestration parent waiting outside the model remains idle. A session that stays idle for five seconds falls back to a 512 MiB soft memory limit, 1 GiB hard limit, and 25 percent CPU quota.

Hard memory limits are lowered only when current usage fits unless Linux reports critically low available memory. The governor touches only muxpilot-owned session scopes and transient heavyweight worker units, and restores live properties it changed during a clean shutdown. Dashboard indicators show current memory, soft/hard limits, CPU use, and CPU quota when metrics are available.

Dedicated scopes require a persistent user-systemd manager. Ordinary operator sessions can continue without one, but agent-created or claimed sessions are refused because they require independent isolation.

## Docker Resource Proxy

Managed sessions receive a muxpilot-owned `DOCKER_HOST` Unix socket. The proxy labels containers created through it, applies the shared Docker memory/CPU pool, caps processes, and rebalances managed containers as they start and stop. Explicit caller limits are retained when stricter.

The proxy does not modify unrelated existing containers. It observes container activity for heavyweight-command liveness and bounds attach/start handshakes. When the Docker daemon is unavailable, Docker calls return a proxy error while non-Docker session work remains usable.

## Browser, PWA, and Connection Recovery

The browser uses an authenticated WebSocket for live events and ordinary HTTP for snapshots and actions. When a laptop sleeps, a mobile browser backgrounds the PWA, or the backend restarts, the app enters a reconnecting screen and refreshes its snapshots after connectivity returns. A disconnected screen keeps retrying and offers an explicit connection restart.

The service worker checks for a new web build at startup and when the document becomes visible. A waiting build shows **A muxpilot update is available**; choosing Reload activates it and refreshes after the service-worker controller changes. Service-worker failure does not disable the ordinary web app.

The mobile layout follows `visualViewport` so the composer remains above the Android/iOS on-screen keyboard and session controls stay reachable within the app viewport.

## Persistence and Maintenance

SQLite stores managed sessions, parsed messages, parser offsets, prompt search, queued inputs, BTW exchanges, orchestration waits, settings, summaries, usage records, notification state, repository history, recovery metadata, Git workspaces, and audit entries. Session documents and runtime/heavy-command logs live in bounded filesystem directories rather than database blobs.

Development and production databases are isolated. Stop a lane before running its compaction command. Compaction removes unused transient event history, verifies the replacement database, and retains a timestamped original backup. Reset commands are intended for development and refuse active ports unless explicitly forced.

Session transfers package portable transcript prefixes, preferences, documents, and eligible committed Git branch objects. They do not include live processes, queued inputs, dirty files, dependencies, or machine-wide Codex settings. See [Usage](usage.md#moving-sessions-between-hosts).

## Failure Diagnosis

Use the narrowest evidence that answers the problem:

1. `pnpm app status` for supervisor, endpoint, PID, and port ownership.
2. `pnpm app logs <mode> --process all --lines 80` for recent server/web/supervisor errors.
3. The session status, failed-input banner, heavy-command modal, and Git workspace panel.

A ready session with no queued input can simply be idle. Do not resend input unless the persisted submission, provider/thread identity, app-server reconciliation state, and queue state support that exact action.
