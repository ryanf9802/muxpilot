# Development Guide

Workspace layout:

- `apps/server`: Fastify API, tmux adapter, Codex JSONL parser, session discovery, SQLite persistence, activity summaries, Codex usage integration, and REST/WebSocket routes.
- `apps/web`: React UI for dashboard cards, grouped sessions, transcript views, pending approval/question flows, queued input, skill suggestions, raw terminal view, and LAN connection details.
- `packages/core`: shared TypeScript API/domain types plus transcript grouping, proposed-plan detection, and user-context normalization helpers used by both apps.
- `scripts`: start/stop/restart helpers, database reset, and Windows/WSL LAN firewall helper.
- `docs`: architecture and operations notes.

The repo is a pnpm workspace. `apps/server` and `apps/web` both depend on `@muxpilot/core` through `workspace:*`.

Useful commands:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm start:dev
pnpm stop
pnpm stop:dev
pnpm restart
pnpm restart:dev
pnpm dev:server
pnpm dev:web
pnpm db:reset:dev
```

Always use `pnpm start:dev` for the development server. It checks whether the local backend and frontend are already running, reuses them when both are active, starts only the missing side when one process is already up, and forces dev state into `./data/dev/muxpilot.db`. Started processes run in the background with PID and log files under `data/runtime/dev/`.
Codex and other automated agents must only interact with the dev server. Do not run or stop the production-preview server from an agent workflow: `pnpm start:prod`, `pnpm stop:prod`, `pnpm restart:prod`, and `pnpm stop` are off-limits for agents.
Use `pnpm stop:dev` to stop the dev server only. `pnpm restart:dev` stops and starts it again. `pnpm restart` restarts only environments that are already running, leaving stopped development or production-preview servers down. `pnpm stop` is an operator convenience that stops both development and production-preview listeners.

`pnpm db:reset:dev` removes the development SQLite database and its WAL/SHM files. It refuses to run while the development ports are active unless `--force` is passed through to `scripts/reset-dbs.mjs`.

Loopback development uses trusted local operator access. To test the phone/LAN flow, run:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm start:dev
```

Then use the Connect device button in the web UI to get the phone URL.

Parser fixtures should be based on small sanitized Codex JSONL snippets. Do not commit full private transcripts.

The backend intentionally avoids arbitrary shell execution. Add tmux operations through `TmuxAdapter` with fixed argv calls.

Keep shared transcript/user-context behavior in `packages/core` when both the server parser and web rendering need the same rules. Keep server-only behavior in `apps/server` and UI-only behavior in `apps/web`.

Build output under `dist/` is disposable. Do not edit generated files directly.
