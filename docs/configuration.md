# Configuration Reference

muxpilot is a single-operator developer console. The Web UI runs in a browser, and the Backend/API server is the trusted process that manages Codex app-server services on the host machine.

## User Settings

- `MUXPILOT_LAN_ENABLED`: set to `1`, `true`, `yes`, or `on` to expose the backend and Web UI on the local network for phone access. Defaults to loopback-only local access.

The app lifecycle scripts load `.env` first and `.env.local` second. Local setup helpers such as `pnpm pwa:setup` write machine-specific settings to `.env.local`, which is ignored by git.

## LAN Example

```bash
MUXPILOT_LAN_ENABLED=1 pnpm app start
```

Open the desktop web UI, press the Connect device button, and use the generated access key or QR code from the modal on your phone.

By default, the backend generates an in-memory remote access key and cookie signing secret on startup. Existing browser access sessions are invalidated after a backend restart, and remote access can also be revoked immediately from the Connect device modal.

If `MUXPILOT_LAN_ENABLED` is false and the app is bound to loopback, local browser requests are trusted and no access key is required.

## Persistence

The SQLite database lives on the Backend/API server host. It is not part of the Web UI bundle and should not be stored in `dist/`.

Development uses `./data/dev/muxpilot.db`. Production uses `./data/prod/muxpilot.db`. Startup creates missing directories but does not overwrite an existing database.

For a durable install outside the repo, configure:

```bash
MUXPILOT_DATA_DIR="$HOME/.local/share/muxpilot"
MUXPILOT_DB_PATH="$HOME/.local/share/muxpilot/muxpilot.db"
```

## Advanced Settings

These are available for unusual local setups but are not needed for normal desktop or LAN use:

- `MUXPILOT_HOST`: override backend bind host. Defaults to `127.0.0.1`, or `0.0.0.0` when LAN is enabled.
- `MUXPILOT_PORT`: backend port, default `4177` in development and `12777` in production. Shadow mode forcibly uses `14177`.
- `MUXPILOT_WEB_PROTOCOL`: published Web UI protocol, `http` or `https`. The lifecycle scripts set this to `https` automatically when both local HTTPS certificate variables are configured.
- `MUXPILOT_WEB_PORT`: Web UI port, default `5177` in development and `12778` in production. Shadow mode forcibly uses `15177`.
- `MUXPILOT_HTTPS_CERT`: optional certificate path for Vite dev/preview HTTPS.
- `MUXPILOT_HTTPS_KEY`: optional private key path for Vite dev/preview HTTPS. Must be set with `MUXPILOT_HTTPS_CERT`.
- `MUXPILOT_PWA_CA_DIR`: optional override for the shared local root CA directory used by `pnpm pwa:setup`. Normal use should put shared CA files in `.certs/pwa-ca/` instead.
- `MUXPILOT_PWA_TRUST_PORT`: optional port for `pnpm pwa:trust`, default `12880`.
- `MUXPILOT_PWA_TRUST_DIR`: directory containing the public CA/profile files served by the phone trust server. `pnpm pwa:setup` writes this machine-specific value to `.env.local`; it is normally not set by hand.
- `MUXPILOT_API_TARGET`: Vite proxy target for `/api`, defaulting to the local backend port selected by the lifecycle script.
- `MUXPILOT_DATA_DIR`: data directory, default `./data/dev` under `pnpm app start dev`, `./data/prod` under `pnpm app start`, and `./data` when the server is started directly. Shadow mode forcibly uses `./data/shadow` in its launching worktree.
- `MUXPILOT_DB_PATH`: SQLite database path, default `./data/dev/muxpilot.db` under `pnpm app start dev`, `./data/prod/muxpilot.db` under `pnpm app start`, and `./data/muxpilot.db` when the server is started directly. Shadow mode forcibly uses `./data/shadow/muxpilot.db`.
- `MUXPILOT_CODEX_HOME`: Codex home on the host machine, default `$HOME/.codex`.
- `MUXPILOT_SKILL_HOME`: root containing muxpilot's installed `skills/` directory, defaulting to `MUXPILOT_CODEX_HOME`. Shadow mode forces this to its exact checkout so burn-in never updates or executes production's installed workflow helpers.
- `MUXPILOT_SESSION_SECRET`: optional HMAC secret of at least 16 characters for persistent operator cookies across restarts.
- `MUXPILOT_OPERATOR_TOKEN`: optional override of at least 12 characters for the generated remote access key. Normal LAN use should leave this unset.
- `MUXPILOT_CORS_ORIGINS`: comma-separated allowlist for credentialed cross-origin API use. Not required for the normal LAN flow.
- `MUXPILOT_LOG_LEVEL`: Pino log level, default `info`.
- `MUXPILOT_SLOW_REQUEST_MS`: response-time threshold for request logging, default `250`. Successful requests below the threshold are not logged; failed requests are always logged.
- `MUXPILOT_RUNTIME_LOG_MAX_BYTES`: lifecycle rotation threshold for each supervisor, backend, and web log, default `67108864` (64 MiB). Rotation occurs before a managed process starts.
- `MUXPILOT_RUNTIME_LOG_RETAINED_FILES`: number of rotated files retained per runtime log, default `3`. Values must be positive integers.
- `MUXPILOT_PARSER_INTERVAL_MS`: Codex JSONL parse interval, default `1000`.
- `MUXPILOT_APP_START_TIMEOUT_MS`: endpoint-health wait after the supervisor launches, default `300000` (five minutes) for production and `30000` for development and shadow. The lifecycle command reports endpoint progress every 10 seconds while it waits. Values must be integers of at least `1000`.
- `MUXPILOT_APP_SERVER_HIBERNATE_MS`: idle time before an eligible app-server service hibernates, default `900000` (15 minutes). Pending input, gates, child waits, heavyweight work, active turns, and background terminals block hibernation.
- `MUXPILOT_RESOURCE_GOVERNOR`: `auto` (default) applies best-effort systemd cgroup and Docker limits to muxpilot-launched sessions; `off` disables both controls.
- `MUXPILOT_AGENT_MEMORY_SOFT_PERCENT`: shared `MemoryHigh` pool for busy agent sessions, default `50`.
- `MUXPILOT_AGENT_MEMORY_HARD_PERCENT`: shared `MemoryMax` pool for busy agent sessions, default `60`.
- `MUXPILOT_AGENT_CPU_PERCENT`: shared percentage of host logical CPU capacity for busy agent sessions, default `75`.
- `MUXPILOT_SESSION_TASKS_MAX`: per-session process/thread ceiling, default `768`.
- `MUXPILOT_DOCKER_MEMORY_SOFT_PERCENT`: shared Docker memory-reservation pool for containers created through managed sessions, default `15`.
- `MUXPILOT_DOCKER_MEMORY_HARD_PERCENT`: shared Docker hard-memory pool, default `20`.
- `MUXPILOT_DOCKER_CPU_PERCENT`: shared Docker CPU pool, default `25`.
- `MUXPILOT_HEAVY_VALIDATION_CONCURRENCY`: number of heavyweight scan/test commands allowed concurrently across muxpilot sessions, default `2`.
- `MUXPILOT_HEAVY_VALIDATION_RESUME_TIMEOUT_MS`: time allowed for a resumed agent to claim a reserved heavyweight slot after the continuation is delivered, default `120000` (two minutes).
- `MUXPILOT_HEAVY_VALIDATION_DIR`: shared lease and live-command metadata directory. The default is a per-user directory under the system temporary directory; relative overrides are resolved when muxpilot starts.
- `MUXPILOT_HEAVY_VALIDATION_INACTIVITY_WARN_MS`: child-output silence before a visible warning, default `60000` (1 minute).
- `MUXPILOT_HEAVY_VALIDATION_INACTIVITY_TIMEOUT_MS`: child-output silence before termination, default `600000` (10 minutes).
- `MUXPILOT_HEAVY_VALIDATION_RUNTIME_TIMEOUT_MS`: maximum command runtime after a slot is acquired, default `1800000` (30 minutes). Queue time is excluded.
- `MUXPILOT_HEAVY_VALIDATION_TERMINATION_GRACE_MS`: time between process-group `SIGTERM` and `SIGKILL`, default `30000` (30 seconds).

Per-run overrides can be placed before `--`, for example `muxpilot-git-run.mjs --heavy --runtime-timeout 20m --inactivity-timeout 5m -- make lint`. In managed sessions, a busy scheduler returns `QUEUED_NOT_RUN` without running the command; muxpilot reserves the ticket in FIFO order and sends an exact resume command when its slot is available. The runner emits queue/start/heartbeat/warning/termination lifecycle messages, records live state for the session UI, and retains the latest 20 command logs (up to 50 MiB each) in the session control directory.
- Plan actions, questions, approvals, and connector permissions use structured app-server requests and responses.

All agent and Docker pool percentages must be greater than zero and no more than 100. A hard-memory percentage must be at least its corresponding soft percentage. The heavyweight inactivity timeout must be greater than its warning threshold.

`MUXPILOT_OPENAI_PRICING_JSON` entries use this shape:

```json
{
  "model-name": {
    "inputUsdPerMillion": 0.8,
    "cachedInputUsdPerMillion": 0.2,
    "outputUsdPerMillion": 3.2
  }
}
```

The built-in pricing table covers `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano` family names used by the summary feature. Unknown models are recorded as unpriced instead of failing.

## Resource Controls

On systemd-based Linux and WSL 2, muxpilot divides the configured agent pools across sessions whose status is initializing, working, generating, executing, planning, or unknown. Sessions that remain idle for five seconds fall back to a 512 MiB soft limit, 1 GiB hard limit, and 25% CPU quota. Hard memory limits are lowered only after current use fits, unless Linux reports less than 8% memory available. Muxpilot restores the scopes it changed to unlimited during a clean shutdown.

Session isolation requires a persistent user systemd manager. Enable it once, verify the user bus, and restart muxpilot:

```bash
sudo loginctl enable-linger "$USER"
test -S "/run/user/$(id -u)/bus"
XDG_RUNTIME_DIR="/run/user/$(id -u)" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" systemctl --user show init.scope --property=Id --value
pnpm app restart prod
```

When the user manager is unavailable, ordinary operator-created sessions continue without a dedicated scope and Docker guarding remains independent. Agent-created sessions are refused rather than silently sharing a parent pool, and an existing unscoped session cannot be claimed as an agent child. After enabling scopes, kill and restore any existing session that needs orchestration or agent ownership so it relaunches with the MCP tools and its own scope.

The governor only changes scopes named `muxpilot-session-<capability>.scope`; it never applies limits to `init.scope` or another ambient user scope.

Managed sessions receive a muxpilot-owned `DOCKER_HOST` Unix socket. Containers created through that socket are labeled, constrained to the shared Docker pool, capped at 512 processes, and rebalanced as managed containers start and stop. Explicit caller limits are preserved when they are stricter. Existing unrelated containers are not changed. If the Docker daemon is unavailable, Docker commands return a clear proxy error while non-Docker work remains available.

Use `pnpm app status` to see the effective pool settings and whether the Docker proxy socket is active. Resource settings are environment-only; changing them requires restarting muxpilot.

See [Runtime Reliability](runtime-reliability.md#session-resource-controls) for allocation behavior, idle fallbacks, Docker proxy boundaries, and operator diagnostics. See [Agent Orchestration](agent-orchestration.md#ownership-and-isolation) for why nested sessions require dedicated scopes.

## Git Workspace Storage

Managed Git session worktrees live outside the repository entry checkout by default:

- `MUXPILOT_GIT_WORKTREE_ROOT` defaults to `~/.muxpilot/worktrees`.
- `MUXPILOT_GIT_SESSION_ROOT` defaults to `~/.muxpilot/sessions` and contains the small neutral control directories used by live Codex chats.

These paths may be overridden when worktrees need to live on a particular filesystem. Do not point them inside a repository working tree.

Git sessions do not create a worktree at launch. The skill creates a uniquely named implementation worktree only for change tasks and removes it immediately after successful local integration. Failed, conflicted, or abandoned worktrees remain available for manual recovery.

See [Local Git Workflow](git-workflow.md) for target selection, dependency localization, validation, integration, and cleanup contracts.

## Internal And Script-Only Environment

The settings above are the supported operator configuration surface. muxpilot also injects environment variables into managed Codex processes and helper commands. They are protocol state, not `.env` settings:

- `MUXPILOT_DOCUMENTS_DIR` identifies the current session's private document scope.
- `MUXPILOT_GIT_ENTRY_PATH`, `MUXPILOT_GIT_REPO_ROOT`, `MUXPILOT_GIT_TARGET_BRANCH`, `MUXPILOT_GIT_STATUS_FILE`, `MUXPILOT_GIT_WORKSPACE_ID`, `MUXPILOT_GIT_HELPER_DIR`, and dependency metadata bind the installed Git skill to one managed workspace.
- `MUXPILOT_SESSION_SCOPES_AVAILABLE` tells orchestration whether independent child scopes can be created.
- `MUXPILOT_HEAVY_QUEUE_ENABLED`, `MUXPILOT_HEAVY_COMPLETION_ENABLED`, `MUXPILOT_HEAVY_BROKER_SOCKET`, `MUXPILOT_HEAVY_BROKER_TOKEN`, and `MUXPILOT_HEAVY_RUN_ID` bind a helper invocation to the managed heavyweight scheduler and completion handoff. Completion handoff and its authenticated private host-side launch broker are enabled only when user-systemd session scopes are available.
- Build, startup-retry, and worktree marker variables are generated by lifecycle helpers for one process launch.

Do not copy these values between sessions or persist them in `.env`. Their validation and lifetime are part of the broker/helper protocols.

The following low-level timing variables exist for focused helper diagnostics and tests, but are not normal operator settings or a compatibility contract:

- `MUXPILOT_CODEX_CHILD_OBSERVATION_MS`, `MUXPILOT_CODEX_CHILD_STABLE_MS`, `MUXPILOT_CODEX_CHILD_LEARNING_MS`, and `MUXPILOT_CODEX_CHILD_TERMINATION_GRACE_MS` tune child-process supervision.
- `MUXPILOT_HEAVY_VALIDATION_POLL_MS`, `MUXPILOT_HEAVY_VALIDATION_STALE_MS`, `MUXPILOT_HEAVY_VALIDATION_CONSOLE_HEARTBEAT_MS`, and `MUXPILOT_HEAVY_VALIDATION_OWNER_HEARTBEAT_MS` tune the heavyweight helper's internal observation cadence.

Prefer per-run heavyweight timeout flags and the supported settings above. Change script-only timing only while diagnosing the corresponding helper with source and tests in view.
