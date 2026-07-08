# muxpilot

`muxpilot` exists for a narrow local workflow: supervising Codex CLI agents that are already running in tmux in a WSL2 development environment. It gives one operator a browser console for seeing what those agents are doing, reading their structured Codex transcripts, sending input, answering prompts, and interacting with sessions from a phone on the same LAN.

It is not a hosted control plane, a general remote shell, or a replacement for tmux. The backend is the trusted local process. It talks to tmux, reads Codex JSONL files from `~/.codex/sessions`, stores local state in SQLite, and exposes constrained HTTP/WebSocket APIs to the React UI.

## What muxpilot is for

The main use case is running several Codex agents in tmux panes and needing a higher-level operator view than raw terminal panes provide:

- See active Codex/tmux sessions grouped by repository.
- Open a session without hunting through tmux windows.
- Read the structured Codex transcript instead of only terminal scrollback.
- Send follow-up input to Codex from the browser.
- Answer Codex approval prompts, plan prompts, and questions.
- Queue input while a session is busy.
- Use a phone as a same-LAN status and response surface.

The supported runtime model is local-first: tmux, Codex, the backend, SQLite, and the web UI all run on the same developer-controlled host. Phone access is same-LAN only (currently).

## Features

- Dashboard cards for discovered Codex/tmux sessions, including repo, branch, status, recent prompts, and optional usage data.
- Structured transcript view based on Codex JSONL files, with user, assistant, tool, approval, question, plan, and context events normalized for the UI.
- tmux-backed input delivery through fixed backend operations, including composer input, queued input, interrupts, input-mode changes, plan choices, question choices, and approval actions.
- Raw terminal view for cases where the structured transcript is not enough.
- Session actions such as rename, detach notice, kill pane, and archive transcript.
- Optional prompt-only activity summaries and OpenAI usage/cost tracking when `OPENAI_API_KEY` is configured.
- Same-LAN phone connection flow with generated access key, QR/link sharing, and optional HTTPS/PWA certificate setup.
- Windows 11 + WSL2 LAN helper scripts for exposing the web UI port to phones on the same network.

## First-time production preview setup

Production preview is the normal manual-operator flow. It builds the workspace, starts the backend and web UI in the background, and uses separate production-preview ports and data from development.

Prerequisites:

- WSL2 Ubuntu or another local Linux-like development host
- tmux
- Node.js 24 or newer
- pnpm
- Codex CLI

Install dependencies and create local config:

```bash
pnpm install
cp .env.example .env
```

Start local-only production preview:

```bash
pnpm start:prod
```

Production-preview defaults:

- Web UI: `http://127.0.0.1:12778`
- Backend: `http://127.0.0.1:12777`
- Database: `./data/prod/muxpilot.db`
- Runtime logs and PIDs: `./data/runtime/prod/`

`pnpm start:prod` runs the build first, checks whether the configured ports are already active, and reuses an existing healthy backend/frontend instead of starting duplicates.

See [docs/setup.md](docs/setup.md) and [docs/deployment.md](docs/deployment.md) for the full setup and LAN HTTPS flow. Do not expose muxpilot directly to the internet.

## Remote access setup

Remote access means same-LAN access from another device, usually a phone. muxpilot is not designed to be exposed directly to the internet.

1. Enable LAN mode in `.env`:

```dotenv
MUXPILOT_LAN_ENABLED=1
```

You can also set it inline for a single run:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm start:prod
```

2. If running from Windows 11 + WSL2, install the Windows and Hyper-V firewall rules for the production-preview web port:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install -Port 12778
```

Run those from PowerShell at the muxpilot repo path. See [docs/windows-wsl-lan.md](docs/windows-wsl-lan.md) for finding the WSL UNC path, verifying the listener, and removing the rules.

3. For installable PWA use or phone camera access to the QR scanner, generate and trust local HTTPS certificates before starting production preview:

```bash
pnpm pwa:setup
```

`pnpm pwa:setup` writes HTTPS settings to `.env.local` and prepares public CA files for phone trust. If the phone will install the certificate over the LAN, also allow the trust-server port in Windows/WSL setups:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install -Port 12880
```

4. Start production preview:

```bash
pnpm start:prod
```

5. If using Windows 11 + WSL2, verify that the production-preview web port is reachable:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 status -Port 12778
```

6. Open the desktop UI at `http://127.0.0.1:12778` or the configured HTTPS URL, press Connect device, and use the generated URL/access key or QR code on the phone.

If HTTPS/PWA certificates are configured, open the Install phone certificate URL or QR code from the Connect device modal first, install and trust the public root CA on the phone, then open the app URL.

The phone must be on the same network as the host. Use the URL shown by the Connect device modal, not `localhost`, `127.0.0.1`, or `0.0.0.0` from the phone.

## Configuration

Most local use only needs `.env` copied from `.env.example`.

Common settings:

- `MUXPILOT_LAN_ENABLED`: set to `1`, `true`, `yes`, or `on` to bind the backend and web UI for same-LAN phone access.
- `OPENAI_API_KEY`: optional. Enables prompt-only activity summaries and OpenAI usage/cost tracking.
- `MUXPILOT_CODEX_HOME`: optional Codex home override. Defaults to `$HOME/.codex`.
- `MUXPILOT_SESSION_SECRET`: optional cookie signing secret if browser access sessions should survive backend restarts.
- `MUXPILOT_DATA_DIR`: optional data directory override.
- `MUXPILOT_DB_PATH`: optional SQLite database path override.

The start scripts load `.env` first and `.env.local` second. Machine-specific helpers such as `pnpm pwa:setup` write to `.env.local`, which is ignored by git.

For every supported environment variable, see [docs/configuration.md](docs/configuration.md).

## Development

Use the development server for agent or implementation work:

```bash
pnpm start:dev
```

Development defaults:

- Web UI: `http://127.0.0.1:5177`
- Backend: `http://127.0.0.1:4177`
- Database: `./data/dev/muxpilot.db`
- Runtime logs and PIDs: `./data/runtime/dev/`

`pnpm start:dev` checks the configured ports first, reuses healthy running servers, and starts only the missing side when needed. Do not use `pnpm dev`; the repo intentionally routes development startup through `pnpm start:dev`.

Useful development commands:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm start:dev
pnpm stop:dev
pnpm restart:dev
pnpm db:reset:dev
```

Automated agents should use only the development server lifecycle. `pnpm start:prod`, `pnpm stop:prod`, `pnpm restart:prod`, and `pnpm stop` are manual-operator commands.

Developer implementation notes live in [docs/development.md](docs/development.md) and [docs/architecture.md](docs/architecture.md). Keep shared transcript and user-context behavior in `packages/core`, backend side effects in `apps/server`, and browser-only behavior in `apps/web`.

## Documentation

- [Setup](docs/setup.md)
- [Configuration](docs/configuration.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Windows 11 WSL2 LAN Access](docs/windows-wsl-lan.md)
