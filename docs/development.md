# Development Guide

Workspace layout:

- `apps/server`: Fastify API, semantic app-server and legacy tmux drivers, structured reconciliation plus JSONL evidence, verified input and queues, SQLite persistence, orchestration/BTW/documents, transfers, Git/heavy brokers, resource controls, usage integration, and REST/WebSocket routes.
- `apps/web`: React UI for dashboard and agent trees, transcript/composer and interactive gates, documents/BTW, Git/heavy controls, transfer/recovery, notifications, PWA/connection handling, and LAN access.
- `packages/core`: shared TypeScript API/domain types plus transcript, status, Git/heavy event, proposed-plan, and user-context normalization used by both apps.
- `scripts`: application lifecycle/supervisor helpers, managed Codex launch/MCP bridges, database maintenance, certificate setup, and Linux/Windows LAN helpers.
- `skills`: bundled agent procedures and Git/heavy helper implementations installed into the configured Codex home.
- `docs`: architecture and operations notes.

The repo is a pnpm workspace. `apps/server` and `apps/web` both depend on `@muxpilot/core` through `workspace:*`.

Useful commands:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm app start dev
pnpm app status dev
pnpm app logs dev --process all
pnpm app stop dev
pnpm restart
pnpm dev:server
pnpm dev:web
pnpm db:reset:dev
pnpm db:compact:dev
```

Always use `pnpm app start dev` for the development server. It checks whether the local backend and frontend are already running, reuses a healthy supervised server, starts the dev supervisor when needed, and forces dev state into `./data/dev/muxpilot.db`. Started processes run in the background with PID and log files under `data/runtime/dev/`.
Codex and other automated development or browser checks must interact only with the dev server. Production is the operator lane; an explicitly requested post-integration restart uses the scoped helper described in [Deployment](deployment.md#updating).
Use `pnpm app stop dev` to stop the dev server only. `pnpm app restart dev` stops and starts it again. `pnpm restart` restarts only environments that are already running, leaving stopped development or production servers down.

`pnpm db:reset:dev` removes the development SQLite database and its WAL/SHM files. It refuses to run while the development ports are active unless `--force` is passed through to `scripts/reset-dbs.mjs`.

`pnpm db:compact:dev` removes unused transient event history and vacuums a stopped development database. It verifies the compacted copy and retains the original database as a timestamped backup.

Loopback development uses trusted local operator access. To test the phone/LAN flow, run:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm app start dev
```

Then use the Connect device button in the web UI to get the phone URL.

On native Linux, allow the development Web UI port with:

```bash
scripts/linux-lan.sh install --port 5177
scripts/linux-lan.sh status --port 5177
```

On Windows 11 + WSL2, use `scripts/windows-lan.ps1` with `-Port 5177`.

Parser fixtures should be based on small sanitized Codex JSONL snippets. Do not commit full private transcripts.

The backend intentionally avoids arbitrary shell execution. Add tmux operations through `TmuxAdapter` with fixed argv calls.

Keep shared transcript/user-context behavior in `packages/core` when both the server parser and web rendering need the same rules. Keep server-only behavior in `apps/server` and UI-only behavior in `apps/web`.

The bundled skill text is part of runtime behavior. Changes to Git targeting rules must stay aligned across the skill, its helper scripts, launch instructions, UI events, and documentation. Orchestration/document contracts must stay aligned with the MCP tool schema, server enforcement, bundled skill, and operator UI. Production startup/restart synchronizes bundled skills into `MUXPILOT_CODEX_HOME`.

Use the focused reference for the subsystem being changed:

- [Architecture](architecture.md) for sources of truth and cross-component data flow.
- [Local Git Workflow](git-workflow.md) for worktree, target, guard, and heavyweight-helper contracts.
- [Agent Orchestration](agent-orchestration.md) for capability, ownership, budget, wait, evidence, and document boundaries.
- [Runtime Reliability](runtime-reliability.md) for delivery, reconciliation, recovery, scheduler, resource, and persistence behavior.

Build output under `dist/` is disposable. Do not edit generated files directly.
