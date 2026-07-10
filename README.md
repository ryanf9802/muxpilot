# muxpilot

muxpilot is a local web console for supervising Codex CLI sessions running in tmux.

It exists for a specific workflow: I run several Codex agents at once, usually inside tmux on a WSL2 development machine, and I want one place to see what they are doing, answer the things that need me, and send follow-up prompts without hunting through terminal windows. The browser UI is useful on the host machine; the phone UI is useful when I am away from the keyboard but still on the same network.

muxpilot is not a hosted agent platform, a replacement for tmux, or a general remote shell. The backend is a trusted local process. It talks to tmux, reads Codex JSONL transcripts from `~/.codex/sessions`, stores local state in SQLite, and exposes a React UI over HTTP/WebSocket.

The intended deployment is one operator, one trusted machine, optional same-LAN phone access. Do not expose muxpilot directly to the internet, no cross-network security measures are (or will be) put in place.

## The Basic Idea

Codex already has the important runtime pieces: the CLI, tmux, structured session logs, and interactive approval/question flows. muxpilot sits on top of those pieces and makes them easier to operate when there is more than one session in flight.

With muxpilot you can:

- See Codex/tmux sessions grouped by repository.
- Open the structured transcript for a session.
- Send normal or plan-mode input to Codex.
- Queue input while Codex is busy.
- Answer approvals, questions, and proposed-plan prompts from the browser.
- Start new Codex sessions in repo directories.
- Search old prompts.
- Get local browser/push notifications when a session needs attention or finishes work.
- Connect a phone on the same LAN using an access key or QR code.
- Install the UI as a local PWA when HTTPS certificates are configured.

New sessions created from muxpilot are placed inside a shared tmux session named `muxpilot`. Existing Codex panes can also be discovered from tmux when they can be matched to Codex session logs.

## What The App Shows

### Dashboard

The dashboard is the operator view for all active sessions.

It includes:

- Repo-grouped session cards.
- Collapsible repo groups.
- Search across repo names, branches, cwd, tmux metadata, previews, summaries, and recent prompts.
- A red/yellow/green stoplight for sessions that need attention, are working, or are ready.
- Status pills for states like `working`, `planning`, `waiting`, `approval`, `question`, `plan_ready`, `missing`, and `unknown`.
- Repo metadata, branch, dirty-worktree signal, transcript size, recent user prompts, and optional activity summaries.
- Per-session actions for rename, notification rules, and kill.
- OpenAI usage/cost summary when `OPENAI_API_KEY` is configured.
- Codex account/rate-limit summary through `codex app-server` when available.

### Session View

The session page is the main working surface for one Codex pane.

It includes:

- Live structured transcript from Codex JSONL.
- Collapsed intermediate activity for tool calls, command output, parser notices, system events, and assistant progress updates.
- Expandable transcript ranges when you need those details.
- Inline proposed-plan actions.
- Inline question forms.
- Approval banner for command/tool/patch/permission prompts.
- Normal/Plan input mode toggle.
- Composer with queue-aware submit behavior.
- Editable queued inputs.
- Prompt skill suggestions.
- Optional Vim composer mode.
- Transcript search.
- Jump-to-top and jump-to-bottom controls.
- Long-transcript paging with scroll-position preservation.
- Copy actions for transcript messages.
- Local tmux attach command copy button.
- Interrupt and kill controls.
- New-session action prefilled from the current repo/cwd.

The transcript UI is intentionally not a raw dump. It keeps user prompts, assistant replies, approvals, questions, plan actions, loaded-instructions notices, aborts, and other useful events visible while folding the noisy activity around them.

## Working With Sessions

### Creating A Session

Use the new-session button or press `Ctrl+N`.

The Create tab asks for:

- Directory: the repo or working directory where Codex should start.
- Name: the tmux window name for the new Codex session.
- Target branch: required for Git repositories and used as the local integration destination.
- Target remote and optional source: used to resolve current remote state and create a missing target without consulting the entry checkout.

Directory suggestions come from active sessions and recently touched repositories. Session names are normalized and must be 2-32 lowercase letters, numbers, or hyphens.

For Git repositories, muxpilot runs `codex` from a neutral control directory and creates no checkout until the agent begins a change task. Before work begins and again before integration, muxpilot reconciles the shared managed target with committed changes from the named local target and configured remote target. Independent histories are merged without force-pushing or rewriting either source; conflicts remain in a target-scoped reconciliation worktree for the agent to resolve. The agent worktree is then rebased onto that forward-only target, reviewed, atomically integrated, and removed. A clean local target checkout is synchronized after integration, while a dirty checkout is left untouched and reported explicitly. Remote publication requires a fresh fetch, exact-SHA confirmation, and a normal non-force push.

The named local target branch is durable and exists as soon as the session is created. If it is missing, muxpilot creates `refs/heads/<target>` from the resolved remote or source commit without checking it out. The temporary `muxpilot/<session>/gN` implementation branch is created later, only when the agent begins change work, and is removed after integration.

Implementation worktrees reuse manifest-associated dependency installations already present in the entry checkout (`node_modules`, Python virtual environments, Composer `vendor`, and Bundler `vendor/bundle`). Tasks that change dependency manifests or lockfiles detach those shared links before installing worktree-local dependencies. Managed sessions receive absolute helper paths through `MUXPILOT_GIT_HELPER_DIR`; `muxpilot-git-status.mjs` reports durable finalization, reconciliation, dependency, local-ref, and remote-ref state after interruptions.

Externally discovered Codex panes remain unmanaged because a running process cannot safely be moved into another working directory. Non-Git directories retain the direct-directory session flow.

The History tab searches restorable sessions that muxpilot has managed before. Search matches only submitted user prompts, not assistant replies, tool output, or command output. Selecting a live result opens the existing pane; selecting a missing or archived result starts a new tmux window with `codex resume <session-id>` and opens the resumed session.

### Sending Input

The composer sends text through a tmux paste buffer and then sends the configured submit key sequence. By default that submit key is `Enter`.

Behavior:

- `Ctrl+Enter` submits the composer.
- If Codex is ready (`waiting` or `idle`), the input is sent immediately.
- If Codex is busy, planning, executing, or already has queued input, muxpilot queues the message.
- Queued input can be edited or deleted until it starts sending.
- Queued input is tied to the current Codex transcript source so it does not get sent into a different run after a pane/source change.
- When the pane becomes ready, muxpilot sends the next queued item automatically.

The Normal/Plan toggle changes Codex collaboration mode by sending the configured tmux key sequence. The default is `BTab`, which is tmux's name for Shift+Tab.

If Codex is waiting on a question or proposed plan, the composer is locked until that prompt is answered.

### Approvals, Questions, And Proposed Plans

muxpilot handles the common interactive Codex gates:

- Approval prompts can be approved once, approved for a prefix when Codex provides a prefix rule, or denied. App/connector permission prompts also expose Codex's session-wide and persistent allow choices.
- Structured questions render as browser form controls.
- Multiple-choice question answers are sent through Codex's menu selection path.
- Free-form question answers are pasted into the pane.
- Proposed plans can be implemented, implemented after clearing context, or left in plan mode.

These actions still operate through tmux. muxpilot is not bypassing the Codex CLI; it is automating the same key/input path you would use manually.

### Prompt History

Press `Ctrl+R` to open prompt history.

Prompt history searches submitted user prompts stored in SQLite and shows repo/session metadata for each result. Selecting a result copies it to the clipboard. Prompt History and the New Session History tab share a persistent SQLite full-text index of displayable user prompts so searches stay quick as transcripts grow.

### Skill Suggestions

Type `$` in the composer to search Codex skills.

Suggestions can include:

- User skills.
- System skills.
- Plugin skills.
- Workspace skills discovered from the session repo/cwd.

Use Arrow Up/Down to move through suggestions, `Enter` or `Tab` to accept, and `Escape` to dismiss. Known `$skill-name` references are highlighted in the composer.

## Keyboard Reference

### Global

These work when focus is not already inside an input, editor, menu, or dialog.

| Key      | Action                               |
| -------- | ------------------------------------ |
| `Ctrl+N` | Open new-session dialog              |
| `Ctrl+R` | Open prompt history                  |
| `i`      | Focus the primary input              |
| `I`      | Focus the primary input at the start |
| `a`      | Focus the primary input for append   |
| `A`      | Focus the primary input at the end   |

On the dashboard, the primary input is search. In a session, it is the composer.

### Session

| Key         | Action                   |
| ----------- | ------------------------ |
| `Backspace` | Return to the dashboard  |

### Composer

| Key              | Action                           |
| ---------------- | -------------------------------- |
| `Ctrl+Enter`     | Send or queue input              |
| `$`              | Start skill suggestion search    |
| Arrow Up/Down    | Move through skill suggestions   |
| `Enter` or `Tab` | Accept selected skill suggestion |
| `Escape`         | Dismiss skill suggestions        |

### Vim Mode

Vim mode is available on desktop-like devices with keyboard and pointer support. It uses CodeMirror with `@replit/codemirror-vim` and shows relative line numbers.

Composer Vim behavior:

| Key                    | Action                                             |
| ---------------------- | -------------------------------------------------- |
| `Ctrl+Enter`           | Send or queue input                                |
| `Escape`               | Leave insert/visual mode, or blur from normal mode |
| `Ctrl+W` then `k`      | Move focus from composer to transcript             |
| `Ctrl+W` then `Ctrl+K` | Move focus from composer to transcript             |

When Vim mode is enabled and focus is on the transcript, these navigation keys are active:

| Key               | Action                     |
| ----------------- | -------------------------- |
| `gg`              | Jump to top/oldest page    |
| `G`               | Jump to bottom/newest page |
| `Ctrl+U`          | Scroll half page up        |
| `Ctrl+D`          | Scroll half page down      |
| `Ctrl+B`          | Scroll one page up         |
| `Ctrl+F`          | Scroll one page down       |
| `/`               | Open transcript find       |
| `Ctrl+W` then `j` | Focus composer             |

## Notifications

Notifications are local to the muxpilot install. They are useful when you have several sessions running and only want to look over when something changes.

Rules can be enabled globally from the top-bar bell or per session from a right-click context menu on the dashboard:

- Done task: a running task returns to `waiting` or `idle`.
- Approval gate: a session enters an attention state such as approval, question, plan-ready, or blocked.
- Status change: any non-missing status transition.

When a rule fires, muxpilot can:

- Ring the session card on the dashboard.
- Show a toast in the open browser.
- Play a short bell sound.
- Send a Web Push notification to registered browsers.

When a notification rule is enabled, the browser may ask for notification permission. Push subscriptions and VAPID keys are stored locally in SQLite.

## Phone And PWA Support

Phone access is same-LAN access to the web UI running on the host machine.

When LAN mode is enabled, the host UI shows a Connect device button. The dialog includes:

- Best detected phone URL.
- Other detected LAN URLs when available.
- Generated access key when remote access requires one.
- QR code for the access URL.
- Revoke button to rotate remote access.
- Optional unrestricted remote-access toggle.
- Optional phone certificate install URL and QR code when PWA trust files are configured.

The phone login page accepts the access key manually. If the phone browser has camera access, it can scan the Connect device QR code. Camera access for LAN IP URLs usually requires HTTPS and a trusted certificate, which is why the repo includes `pnpm pwa:setup`.

PWA support includes a web manifest, service worker, app icons, local HTTPS certificate setup, and a small trust-file server for public root CA files.

On iOS, after installing the muxpilot root CA profile, enable full trust for it in Settings. On Android, install the CA into user credentials.

## Setup

Prerequisites:

- WSL2 Ubuntu or another local Linux-like development host.
- tmux.
- Node.js 24 or newer.
- pnpm.
- Codex CLI.

Install dependencies and create local config:

```bash
pnpm install
cp .env.example .env
```

Start production mode:

```bash
pnpm app start
```

Open:

```text
http://127.0.0.1:12778
```

Check status and logs:

```bash
pnpm app status
pnpm app logs
```

For development mode:

```bash
pnpm app start dev
```

Development and production use separate ports, databases, and runtime logs.

## Runtime Commands

Use `pnpm app ...` for normal operation. The app runs on the host machine under the current user so it can control that user's tmux/Codex sessions. The command starts a small supervisor in the background; you do not need to leave the terminal open.

| Command                                     | Purpose                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| `pnpm app start`                            | Build, then start or reuse production                      |
| `pnpm app start dev`                        | Start or reuse development                                 |
| `pnpm app stop`                             | Stop production                                            |
| `pnpm app stop dev`                         | Stop development                                           |
| `pnpm app restart`                          | Restart production                                         |
| `pnpm app restart dev`                      | Restart development                                        |
| `pnpm app restart all` or `pnpm restart`    | Restart only modes that are already running                |
| `pnpm app status` or `pnpm status`          | Show production and development process health             |
| `pnpm app logs` or `pnpm logs`              | Show production backend logs                               |
| `pnpm app logs prod --process all --follow` | Follow production supervisor, backend, and web logs        |
| `pnpm db:reset:dev`                         | Reset dev SQLite state                                     |
| `pnpm db:reset:prod`                        | Reset production SQLite state                              |
| `pnpm pwa:setup`                            | Create/reuse HTTPS/PWA certificates and write `.env.local` |
| `pnpm pwa:trust`                            | Run the phone trust-file helper                            |
| `pnpm pwa:certs:status`                     | Print PWA certificate status                               |
| `pnpm build`                                | Build all packages/apps                                    |
| `pnpm typecheck`                            | Type-check all packages/apps                               |
| `pnpm test`                                 | Run tests                                                  |

`pnpm dev` intentionally exits and points you to `pnpm app start dev`.

Production startup automatically installs or updates the bundled `muxpilot-git-workflow` skill in `MUXPILOT_CODEX_HOME` (default `~/.codex`). This synchronization also runs when production is already active, so rerunning `pnpm app start` is enough to refresh the skill after updating muxpilot.

Development defaults:

- Web UI: `http://127.0.0.1:5177`
- Backend: `http://127.0.0.1:4177`
- Database: `./data/dev/muxpilot.db`
- Runtime logs/PIDs: `./data/runtime/dev/`

Production defaults:

- Web UI: `http://127.0.0.1:12778`
- Backend: `http://127.0.0.1:12777`
- Database: `./data/prod/muxpilot.db`
- Runtime logs/PIDs: `./data/runtime/prod/`

Each runtime directory contains `supervisor.log`, `server.log`, `web.log`, and matching PID files. The supervisor restarts a crashed backend or web process while the host/WSL instance remains running. If Windows, WSL, or the machine itself restarts, run `pnpm app start` again.

To update muxpilot:

```bash
git pull
pnpm install
pnpm app restart
```

Automated coding agents should use the development lane. Production commands are intended for the human operator.

## Same-LAN Phone Setup

Enable LAN mode:

```dotenv
MUXPILOT_LAN_ENABLED=1
```

Or run it for one command:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm app start
```

Open muxpilot on the host and use Connect device. From the phone, use the URL shown there. Do not use `localhost`, `127.0.0.1`, or `0.0.0.0` from the phone.

For native Linux, install and verify the Web UI firewall rule:

```bash
scripts/linux-lan.sh install --port 12778
scripts/linux-lan.sh status --port 12778
```

For Windows 11 + WSL2, install firewall rules for the web port from an Administrator PowerShell at the muxpilot repo path:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install -Port 12778
```

Check reachability:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 status -Port 12778
```

For development mode, use port `5177`.

Full native Linux notes are in [docs/linux-lan.md](docs/linux-lan.md). Full WSL2 notes are in [docs/windows-wsl-lan.md](docs/windows-wsl-lan.md).

## HTTPS And PWA Certificates

For phone camera login, installable PWA behavior, and secure-context APIs over LAN, use the certificate helper:

```bash
pnpm pwa:setup
pnpm app start
```

`pnpm pwa:setup` creates or reuses a muxpilot local root CA, issues a host certificate for localhost and detected LAN addresses, writes HTTPS settings to `.env.local`, prepares public CA files for phone install, and tries to trust the CA on the host.

If the phone will install the certificate over LAN, allow the trust-server port too. On native Linux:

```bash
scripts/linux-lan.sh install --port 12880
```

On Windows 11 + WSL2:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-lan.ps1 install -Port 12880
```

Install the phone certificate from Connect device before opening the HTTPS app URL.

Keep the root CA private key private. Devices that trust this CA will trust certificates issued from it.

## Access Model

Loopback local use is trusted. A browser on `127.0.0.1` does not need an access key.

LAN mode requires an access key by default. The host-only Connect device modal shows the current key, access URLs, QR codes, and revoke action. Access keys included in query strings are stripped from the phone login page after they are read.

The Connect device modal also has an unrestricted remote-access toggle. Use it only on a trusted LAN. It lets remote devices connect without the access key.

By default, muxpilot generates the access key and cookie signing secret at startup, so browser/phone access sessions may be invalidated after restart. Set `MUXPILOT_SESSION_SECRET` if you want access cookies to survive restarts.

## Configuration

Most local use only needs `.env` copied from `.env.example`:

```dotenv
MUXPILOT_LAN_ENABLED=0
OPENAI_API_KEY=
```

Common settings:

- `MUXPILOT_LAN_ENABLED`: set to `1`, `true`, `yes`, or `on` for phone access.
- `OPENAI_API_KEY`: optional. Enables prompt-only activity summaries and OpenAI usage/cost tracking.
- `MUXPILOT_CODEX_HOME`: optional Codex home override. Defaults to `$HOME/.codex`.
- `MUXPILOT_SESSION_SECRET`: optional cookie signing secret for access sessions across restarts.
- `MUXPILOT_DATA_DIR`: optional data directory override.
- `MUXPILOT_DB_PATH`: optional SQLite path override.
- `MUXPILOT_HOST`, `MUXPILOT_PORT`, `MUXPILOT_WEB_PORT`: bind/port overrides.
- `MUXPILOT_INPUT_MODE_CYCLE_KEYS`: key sequence for switching Codex normal/plan mode. Defaults to `BTab`.
- `MUXPILOT_INPUT_SUBMIT_KEYS`: key sequence sent after pasted composer input. Defaults to `Enter`.
- `MUXPILOT_APPROVAL_APPROVE_ONCE_KEYS`, `MUXPILOT_APPROVAL_APPROVE_PREFIX_KEYS`, `MUXPILOT_APPROVAL_DENY_KEYS`: key sequences for approval gates.
- `MUXPILOT_SUMMARY_MODEL`, `MUXPILOT_SUMMARY_INTERVAL_MS`, `MUXPILOT_SUMMARY_DEBOUNCE_MS`: activity summary behavior.
- `MUXPILOT_OPENAI_PRICING_JSON`: optional pricing overrides for usage/cost estimates.

The lifecycle scripts load `.env` first and `.env.local` second. Machine-specific output from `pnpm pwa:setup` belongs in `.env.local`.

See [docs/configuration.md](docs/configuration.md) for the full reference.

## How Discovery Works

muxpilot periodically lists tmux panes and recent Codex session files.

For each session it records:

- tmux session/window/pane IDs.
- cwd and current command.
- repo root, repo name, branch, worktree, and dirty state.
- matched Codex session ID and JSONL path.
- transcript size and recent prompt activity.
- inferred status from tmux/Codex state.

If the Codex JSONL source for a pane changes, muxpilot treats it as a source change and resets the stored transcript for that app session. That keeps stale transcript data from appearing under a new Codex run.

## Statuses

Common session statuses:

- `working`, `generating`, `executing`: Codex appears busy.
- `planning`: Codex is working in plan mode.
- `waiting`, `idle`: input is likely safe to send.
- `approval`: Codex is waiting on an approval gate.
- `question`: Codex asked a structured question.
- `plan_ready`: Codex has proposed a plan and wants a choice.
- `blocked`: Codex reported a blocked state.
- `missing`: the tmux pane is gone or no longer discoverable.
- `unknown`: muxpilot sees the pane but cannot confidently infer the state.

Stoplight grouping:

- Red: attention needed.
- Yellow: working or unknown.
- Green: ready/idle/waiting.

## Troubleshooting

No sessions show up:

- Make sure Codex is running inside tmux under the same OS/WSL user that started muxpilot.
- Check that `tmux list-panes -a` works from the same shell.
- If Codex uses a non-default home, set `MUXPILOT_CODEX_HOME`.

Input does not reach Codex:

- Confirm the tmux pane still exists.
- Confirm the backend user can access the tmux socket.
- If mode switching is wrong, check `MUXPILOT_INPUT_MODE_CYCLE_KEYS`.

Phone cannot connect:

- Use the URL from Connect device.
- Confirm `MUXPILOT_LAN_ENABLED=1`.
- Confirm the phone is on the same LAN and not on guest WiFi.
- On native Linux, run `scripts/linux-lan.sh status --port 12778` for the web port.
- On Windows/WSL2, run `scripts/windows-lan.ps1 status` for the web port.

QR scanner is missing or camera fails:

- Open the app over HTTPS on the phone.
- Install and trust the muxpilot local root CA from Connect device.
- Make sure the trust-server port is reachable if installing the CA over LAN.

Access key is rejected:

- Open Connect device on the host and use the current key.
- Revoke remote access and scan/copy the new URL if the key may be stale.

Installed PWA opens before the backend is ready:

- Leave it open. The UI shows a reconnect screen and polls until the backend returns.

Skill suggestions are missing:

- Check that `MUXPILOT_CODEX_HOME` points to the Codex home with your skills/plugins.
- Workspace skills depend on the session repo/cwd being discoverable.

OpenAI summaries or usage are missing:

- Set `OPENAI_API_KEY` for activity summaries and OpenAI usage/cost tracking.
- Codex account/rate-limit data depends on `codex app-server` being available and authenticated.

## Development

Repo layout:

- `apps/web`: React/Vite UI.
- `apps/server`: Fastify backend, tmux/Codex/session services, SQLite persistence.
- `packages/core`: shared types and transcript/user-context helpers.
- `scripts`: app lifecycle/supervisor, PWA certs, icons, DB reset, Linux and Windows LAN helpers.
- `docs`: focused setup/config/development/deployment notes.

Useful development commands:

```bash
pnpm app start dev
pnpm build
pnpm typecheck
pnpm test
pnpm restart
```

Keep shared transcript behavior in `packages/core`, backend side effects in `apps/server`, and browser-only behavior in `apps/web`.

More detail:

- [Setup](docs/setup.md)
- [Configuration](docs/configuration.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Native Linux LAN Access](docs/linux-lan.md)
- [Windows 11 WSL2 LAN Access](docs/windows-wsl-lan.md)
