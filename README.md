# muxpilot

muxpilot is a single-operator console for supervising local Codex CLI sessions that are already running in tmux. It provides a browser UI for viewing sessions, reading structured Codex transcripts, sending input, answering Codex approval/question prompts, and connecting a phone on the same LAN.

The backend is the trusted process. It talks to tmux, reads Codex JSONL files from `~/.codex/sessions`, stores local state in SQLite, and exposes constrained HTTP/WebSocket APIs to the React UI.

## Workspace

This repository is a pnpm workspace:

- `apps/server`: Fastify API, tmux adapter, Codex JSONL parser, SQLite persistence, session discovery, activity summaries, and Codex usage integration.
- `apps/web`: React UI for the dashboard, session transcript, composer, pending approvals/questions, queued input, skill suggestions, raw terminal view, and LAN connection modal.
- `packages/core`: shared TypeScript API/domain types and shared transcript, proposed-plan, and user-context helpers used by both apps.
- `scripts`: local run, stop, database reset, and Windows/WSL LAN firewall helpers.
- `docs`: setup, configuration, development, architecture, deployment, and Windows/WSL LAN notes.

Generated `dist/` directories are build output. Runtime state belongs under `data/` or a configured external data directory.

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm run:dev
```

Development defaults:

- Backend: `http://127.0.0.1:4177`
- Web UI: `http://127.0.0.1:5177`
- Database: `./data/dev/muxpilot.db`

`pnpm run:dev` checks the configured ports first and reuses an already-running backend/frontend when possible.

## Phone Access

For same-LAN phone access:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm run:dev
```

Open the desktop UI, use the Connect device button, and scan the QR code or copy the generated URL/access key. On Windows 11 + WSL2, see [docs/windows-wsl-lan.md](docs/windows-wsl-lan.md).

## Common Commands

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm run:dev
pnpm dev:stop
pnpm db:reset:dev
```

`pnpm run:prod` is a local production-preview flow for manual operator use. Automated agents should use the development server only.

## Documentation

- [Setup](docs/setup.md)
- [Configuration](docs/configuration.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Windows 11 WSL2 LAN Access](docs/windows-wsl-lan.md)
