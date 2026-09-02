<p align="center">
  <img src="apps/web/public/icons/muxpilot.svg" alt="muxpilot" width="96" height="96">
</p>

<h1 align="center">muxpilot</h1>

<p align="center">
  A local, phone-friendly control surface for parallel Codex sessions.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1ff989" alt="MIT license"></a>
</p>

muxpilot gives one operator a single place to watch multiple Codex sessions, answer the ones that need attention, and send follow-up prompts without hunting through terminal windows. Use it from the development machine or check in from a phone on the same network.

It is a local companion to Codex, not a hosted agent platform or a general remote shell. New sessions use Codex app-server by default; existing and explicitly selected tmux sessions remain fully supported. The backend runs as your user and stores its durable operator state in SQLite.

> [!WARNING]
> muxpilot is designed for one trusted machine and optional same-LAN access. Do not expose it directly to the internet.

## Why muxpilot?

Running one coding agent in a terminal is easy. Running several across repositories creates an operator problem: which session is working, which one needs approval, and where did that useful conversation go?

muxpilot adds an operator layer without replacing the tools already doing the work:

- **One dashboard for every session.** Group Codex/tmux sessions by repository and see their branch, worktree, activity, and attention state.
- **Structured conversations.** Read Codex JSONL as a focused transcript instead of a raw terminal dump.
- **Interactive control.** Send or queue prompts with verified delivery, answer questions and approvals, act on proposed plans, switch Normal, Plan, Fast, and Vim controls, interrupt work, and start or fork sessions.
- **Managed local Git work.** Launch repository sessions in isolated worktrees with focused validation, self-review, atomic commits, and local integration safeguards.
- **Visible delegated work.** Run durable agent-managed child sessions with independent context and resources, bounded budgets, parent/child status rollups, and event-driven wake-ups.
- **Non-interrupting side questions.** Use BTW for an independent answer or safe document update while the main Codex turn keeps working.
- **Durable local history.** Search past prompts, resume sessions, and transfer conversations between machines with optional encryption.
- **Agent-managed documents.** Let long-running agents maintain persistent Markdown plans, checklists, reminders, and acceptance criteria outside the conversation context.
- **Recovery and resource controls.** Restore conversations after an unclean shutdown, inspect failed input and heavyweight commands, and keep sessions and managed Docker work inside shared limits.
- **Notifications that matter.** Get browser, sound, or Web Push alerts when work finishes or a session needs attention.
- **A real phone workflow.** Connect over the LAN with an access key or QR code and install the interface as a PWA with local HTTPS.

## How it works

```text
Desktop or phone browser
          │
          ▼
  muxpilot web UI ── HTTP/WebSocket ──► local muxpilot server
                                              │
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
             Codex app-server          legacy tmux             SQLite
              systemd services          CLI panes
```

For app-server sessions, structured protocol state and muxpilot-owned systemd services are authoritative for lifecycle and input. Legacy sessions retain tmux pane semantics. Codex session files remain durable transcript evidence, and SQLite holds queued input, prompt history, gates, recovery state, and parsed messages.

## Quick start

### Requirements

- WSL2 Ubuntu or another local Linux-like host
- systemd user services (recommended app-server runtime); [tmux](https://github.com/tmux/tmux) only for the legacy runtime
- [Codex CLI](https://github.com/openai/codex)
- Node.js 24 or newer
- pnpm 11.12.0, matching the repository's `packageManager` pin

### Install and run

```bash
git clone https://github.com/ryanf9802/muxpilot.git
cd muxpilot
pnpm install
cp .env.example .env
pnpm app start
```

Open [http://127.0.0.1:12778](http://127.0.0.1:12778).

The production command builds the workspace, starts a background supervisor, waits for both services to become healthy, and installs or refreshes muxpilot's bundled Codex skills in your Codex home.

```bash
pnpm app status
pnpm app logs
pnpm app restart
pnpm app stop
```

See the [setup guide](docs/setup.md) for runtime paths, updates, and troubleshooting.

## Phone access

Set LAN mode in `.env`:

```dotenv
MUXPILOT_LAN_ENABLED=1
```

Restart muxpilot, open it on the host, and choose **Connect device** for the current phone URL and access key. For QR scanning, secure-context browser APIs, and installable PWA support, configure local certificates first:

```bash
pnpm pwa:setup
pnpm app restart
```

LAN firewall setup differs between [native Linux](docs/linux-lan.md) and [Windows 11 with WSL2](docs/windows-wsl-lan.md). The setup guide covers the full [phone connection flow](docs/setup.md#phone-access-on-the-same-network).

## Security model

muxpilot is intentionally local-first:

- Loopback access is trusted and does not require an access key.
- LAN access is opt-in and requires a generated access key by default.
- The browser talks to constrained HTTP and WebSocket endpoints; it cannot submit arbitrary shell commands.
- The server runs as the current user because it needs that user's tmux socket and Codex session files.
- HTTPS support uses a local certificate authority. Keep its private key private.
- Internet-reachable deployment, multi-user isolation, and remote shell access are out of scope.

Read [Architecture](docs/architecture.md) and [Deployment](docs/deployment.md) before changing the trust boundary.

## Using muxpilot

The dashboard is organized around attention: red sessions need input, yellow sessions are active or uncertain, and green sessions are ready. Open a card to view the structured transcript, send or queue input, handle interactive gates, ask a BTW side question, inspect documents and runtime evidence, monitor heavyweight work, and manage the session. Agent-created sessions remain visible in a nested tree with context, budget, and rolled-up status.

The [usage guide](docs/usage.md) covers:

- Creating, forking, resuming, and transferring sessions
- Managed and standalone Git worktrees and target branches
- Nested agent sessions, BTW side questions, and persistent documents
- Queued input, approvals, questions, and proposed plans
- Verified input recovery, Fast mode, prompt history, skill suggestions, and keyboard controls
- Notifications, phone/PWA behavior, crash recovery, discovery, and statuses

## Development

Start the isolated development lane:

```bash
pnpm app start dev
```

Development uses separate ports, logs, and SQLite data from production. Automated coding agents should use this lane; production is reserved for operator use.

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm app logs dev --process all
pnpm app stop dev
```

The workspace contains a React/Vite web app, a Fastify server, and a shared TypeScript core package. See the [development guide](docs/development.md) and [architecture overview](docs/architecture.md) before making structural changes. Never commit private Codex transcripts; test fixtures should be small and sanitized.

## Documentation

| Guide | Contents |
| --- | --- |
| [Setup](docs/setup.md) | Installation, runtime commands, phone access, updates, and troubleshooting |
| [Usage](docs/usage.md) | Session workflows, interactive controls, shortcuts, notifications, and statuses |
| [Local Git workflow](docs/git-workflow.md) | Managed and standalone worktrees, targets, guards, validation, and local integration |
| [Agent orchestration](docs/agent-orchestration.md) | Nested sessions, ownership, tool contracts, budgets, waits, evidence, documents, and BTW |
| [Runtime reliability](docs/runtime-reliability.md) | Supervision, reconciliation, input delivery, recovery, heavyweight work, and resource controls |
| [Configuration](docs/configuration.md) | Environment variables and defaults |
| [Development](docs/development.md) | Workspace layout, commands, and code boundaries |
| [Architecture](docs/architecture.md) | Components, data flow, persistence, and trust model |
| [Deployment](docs/deployment.md) | Production runtime and operational notes |
| [Style guide](docs/style-guide.md) | Visual tokens and UI usage rules |
| [Linux LAN access](docs/linux-lan.md) | Native Linux firewall and reachability setup |
| [Windows/WSL LAN access](docs/windows-wsl-lan.md) | Windows 11 and WSL2 network setup |

## Project status

muxpilot is early-stage, maintainer-built software shaped around a specific Codex + tmux workflow. Interfaces and behavior may change as that workflow evolves.

## License

muxpilot is available under the [MIT License](LICENSE).
