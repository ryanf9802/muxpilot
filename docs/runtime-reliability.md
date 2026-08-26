# Runtime Reliability Reference

muxpilot sits between a browser, tmux, live Codex processes, append-only Codex transcripts, and local SQLite state. This guide describes how those sources are supervised and reconciled, and what an operator can inspect when a state transition fails.

## Supervised Application Lifecycle

`pnpm app start [prod|dev]` builds or starts the selected lane, launches a background supervisor, and waits for the backend and web endpoints to become healthy. The supervisor owns the server and web child processes and restarts either one after an unexpected exit.

Production and development use separate ports, databases, logs, PID files, and runtime directories. `pnpm app status` classifies each lane as `running`, `stopped`, `unmanaged`, `partial`, `unhealthy`, `stale-pid`, or `port-conflict`. `restart all` restarts only lanes that were already running.

Stop and restart terminate tracked descendants and process groups, not only the parent package-manager PID. This prevents Vite, `tsx watch`, or other children from retaining listeners after the supervisor exits.

See [Setup](setup.md), [Deployment](deployment.md), and [Configuration](configuration.md) for commands and paths.

## Managed Codex Launches

muxpilot launches new, resumed, and forked Codex sessions through a repo-owned wrapper. Each launch disables Codex's startup update prompt for that process, applies the requested collaboration/model settings, and injects only the capability-bound MCP servers needed by the session.

If Codex exits during its first 15 seconds, the wrapper retries up to three times unless the command is missing, cannot execute, or was interrupted. A final startup failure leaves the tmux pane open with `startup_failed` state and the exit evidence visible instead of immediately losing the pane.

A small child supervisor learns the durable stdio tool-server commands started by Codex. If context compaction starts an identical replacement without retiring the older process, it keeps the replacement and terminates the stale tree. When the Codex runtime exits, it cleans up the tool-server children it learned rather than leaving duplicate servers behind.

## Discovery and Transcript Reconciliation

tmux is authoritative for live panes and input transport. Codex JSONL files are authoritative for structured conversation events. SQLite holds muxpilot's parsed and local state.

At startup muxpilot synchronously discovers current panes so the newest sessions appear quickly, then catches up transcript history in the background with recent JSONL files first. Notifications start only after catch-up establishes a quiet baseline, preventing old status transitions from producing a burst of alerts.

Discovery and parsing continue on independent intervals. The parser persists byte offsets and can make multiple bounded passes over a growing transcript. When a pane starts writing to a different Codex JSONL source, muxpilot changes the source identity and resets the displayed transcript instead of mixing two conversations.

Initializing sessions remain visible while Codex reaches its ready screen. Live WebSocket events update the dashboard immediately, while periodic reconciliation repairs missed or stale client state.

## Verified Input Delivery

Operator and agent messages are persisted before tmux input begins. A submission records the destination Codex session/source identity, collaboration mode, prompt hash and length, attempt counters, actor, and delivery phase.

Delivery then follows a guarded state machine:

1. Load the exact text into a tmux paste buffer and paste it into the Codex composer.
2. Verify the composer contains the expected prompt, including wrapped or collapsed paste displays.
3. Send the configured submit keys and wait for Codex acknowledgement through transcript lifecycle or an active status.
4. If the prompt is still present, retry the submit key once.
5. If Codex is still ready and the composer is empty, replay the preserved prompt once.
6. Stop with `input_failed` rather than guessing after the safe retry budget is exhausted.

The acknowledgement deadline is 30 seconds. muxpilot never overwrites a composer containing different text. Failures distinguish missing paste observation, rejected submit, no acknowledgement, changed composer, unavailable session, legacy unverified state, and tmux transport failure.

An input failure blocks new composer messages. The session view preserves the exact submitted message and exposes **Retry input** and **Dismiss**. Retry first verifies Codex is ready and either submits an exact matching existing draft or restores the preserved prompt into an empty composer. Dismiss clears the blocking state without claiming that Codex received the message.

Pending deliveries are reconciled after backend restart, pane rediscovery, transcript rollover, and queued-input processing. A matching Codex lifecycle event marks the persisted submission acknowledged; a completed restored delivery is not sent again.

## Queued Input

Input is queued when Codex is busy or another item is already queued. The queue is persisted in SQLite and bound to the current Codex transcript source. Operators can edit the text or collaboration mode, or delete the item, until delivery begins.

Only one queued item is processed at a time. It advances when discovery reports a ready pane and no unresolved interactive gate or failed delivery remains. A source change prevents queued text from leaking into a different Codex run.

## Crash Session Recovery

During clean operation muxpilot records the non-archived Codex panes that are open. If the server later starts after an unclean shutdown, it compares that snapshot with current tmux state. Missing conversations appear in one recovery dialog with all candidates selected by default.

Restoring a candidate creates a new tmux window with Codex's native resume command and reconnects muxpilot metadata, documents, and managed Git binding. It restores the durable conversation, not the operating-system process or command that was running when the host stopped. Dismissed candidates remain available through session History.

## Heavyweight Command Scheduler

Managed Git sessions share a FIFO scheduler for expensive tests, scans, builds, and Docker workloads. Active commands move through `waiting`, `reserved`, `running`, `stalled`, `terminating`, and `reporting` states.

When all slots are busy, the wrapper reports `QUEUED_NOT_RUN` and ends the agent turn. muxpilot holds the ticket outside the model, reserves a slot when available, and resumes the session with an exact claim command. Queue time does not consume runtime or inactivity deadlines. An interrupted or expired reservation does not count as a test failure because the original command never ran.

Once a managed command starts, the helper asks muxpilot's host-side launch broker to create a transient user-systemd service that survives the model tool scope. The authenticated request crosses a mode-0600 Unix socket and contains only validated run metadata; its runtime-scoped broker capability is also mode 0600. The launch environment travels directly from launcher to worker over a separate private socket rather than command-line arguments or a persisted environment file. Muxpilot watches the persisted run outside the model and resumes the agent when the worker exits. Successful completions contain only the outcome, duration, exit metadata, command, and retained-log path. Failures and terminations also include a bounded diagnostic tail; fuller output stays in the private capped log. Standalone workflow helpers, and installations without managed user-systemd scopes, remain synchronous because they have no safe continuation channel.

New operator messages are held while a run is waiting or reserved, and while a resumed command is active. If an operator interrupt ends the deferred phase, the held message is delivered normally and any later resume request for that run is stale; the agent must not replay the abandoned command on its own.

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
3. The session status, failed-input banner, heavy-command modal, Git workspace panel, and raw terminal view.
4. For agent orchestration mismatches, compare persisted session state with raw tmux panes, process trees, and Codex JSONL evidence as described in [Agent Orchestration](agent-orchestration.md#raw-evidence-tools).

A ready pane with no queued input can simply be idle. Do not resend or overwrite a draft unless the persisted submission, transcript source, terminal composer, and queue state all support that exact action.
