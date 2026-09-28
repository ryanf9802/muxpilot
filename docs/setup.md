# Setup

Prerequisites:

- WSL2 Ubuntu or another local Linux-like host.
- A persistent user-systemd manager for provider session runtimes.
- Codex CLI for Codex sessions.
- Claude Code CLI for Claude sessions, plus `bubblewrap` and `socat` for its mandatory sandbox (`sudo apt install bubblewrap socat` on Ubuntu).
- Node.js 24 or newer.
- pnpm 11.21.0, matching the repository's `packageManager` pin.

Fresh install:

```bash
git clone https://github.com/ryanf9802/muxpilot.git
cd muxpilot
pnpm install
cp .env.example .env
pnpm app start
```

Open:

```text
http://127.0.0.1:12778
```

## Providers

Each session runs on one provider: Codex (through Codex app-server) or Claude (through Claude Code and the Claude Agent SDK). Both are enabled by default. Use `MUXPILOT_PROVIDERS` to enable only one, and `MUXPILOT_DEFAULT_PROVIDER` to choose the initial default. See [Configuration](configuration.md#providers).

Provider sign-in is managed by each provider's CLI on the muxpilot host. muxpilot has no login button; it shows the command to run when a provider is signed out:

```bash
codex login
claude auth login
```

muxpilot watches each provider's credentials independently. While a provider's account is changing, new sessions and input for that provider are held. After a sign-out, its live sessions stop at a safe boundary and must be resumed after sign-in; after an account change, they restart under the new account. The other provider is unaffected.

Claude sessions use the CLI login, not API keys: muxpilot removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from Claude runtimes unless `MUXPILOT_CLAUDE_ALLOW_API_KEY=1` is set. If `bwrap` or `socat` is missing, the Claude provider reports `sandbox_unavailable` and Claude sessions cannot start until both are installed and muxpilot is restarted.

`pnpm app status` prints one availability line per enabled provider.


Useful production commands:

```bash
pnpm app status
pnpm app logs
pnpm app logs prod --process all --follow
pnpm app restart
pnpm app stop
```

Production defaults:

- Web UI: `http://127.0.0.1:12778`
- Backend: `http://127.0.0.1:12777`
- Database: `./data/prod/muxpilot.db`
- Runtime logs/PIDs: `./data/runtime/prod/`

The runtime directory contains `supervisor.log`, `server.log`, `web.log`, `supervisor.pid`, `server.pid`, and `web.pid`.

## Development Mode

Run the development servers:

```bash
pnpm app start dev
```

Development mode uses `127.0.0.1:4177` for the backend, `127.0.0.1:5177` for the Web UI, `./data/dev/muxpilot.db` for SQLite, and `data/runtime/dev/` for logs/PIDs.

Stop or restart development mode:

```bash
pnpm app stop dev
pnpm app restart dev
```



## Phone Access On The Same Network

Loopback local use does not require an access key. Before exposing the app to your LAN, set `MUXPILOT_LAN_ENABLED=1`.

For installable PWA use and QR-code camera login from a phone, generate local HTTPS certificates first:

```bash
pnpm pwa:setup
```

This creates or reuses the muxpilot local root CA, issues a host certificate for the current LAN addresses, writes the HTTPS settings to `.env.local`, and prepares public CA files for phone trust.

By default, the shared root CA lives in `.certs/pwa-ca/`. The directory exists in the repo as an ignored drop-in location: keep or copy `rootCA.pem` and `rootCA-key.pem` there if you want this host to use the same trusted CA as another muxpilot host. Do not commit or share `rootCA-key.pem` casually.

`pnpm pwa:setup` also tries to trust the root CA on the host. In WSL, it imports the CA into the Windows current-user Trusted Root store so Chrome/Edge treat `https://127.0.0.1:12778` and the LAN HTTPS URL as secure. If host trust is skipped, the command prints the reason and the browser may still show `ERR_CERT_AUTHORITY_INVALID`.

Start the app bound to the LAN:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm app start
```

Open the app on your desktop, press the Connect device button in the top bar, and open the shown URL on your phone. The URL usually looks like:

```text
https://192.168.1.25:12778
```

Use the Connect device modal on the host machine to copy the generated access key or scan the QR code. The phone browser talks to the Web UI over the LAN, and the backend controls the local provider runtimes on the desktop.

If the phone cannot reach the URL, install and verify the host firewall rule. On native Linux:

```bash
scripts/linux-lan.sh install --port 12778
scripts/linux-lan.sh status --port 12778
```

On Windows 11 + WSL2, use [Windows WSL LAN Access](./windows-wsl-lan.md).

If HTTPS PWA certs are configured, the Connect device modal also shows an Install phone certificate URL and QR code. Open that first on the phone, install the public root CA, then open the HTTPS app URL. The private CA key is never served by the app. On iOS, enable full trust for the installed profile in Settings. On Android, install the CA certificate in user credentials.

By default, the backend generates an in-memory access key and cookie signing secret on startup. Existing phone/browser access sessions are invalidated after a backend restart. Set `MUXPILOT_SESSION_SECRET` only if you want browser access cookies to survive restarts when the access generation has not been revoked.

To find the LAN IP manually:

```bash
hostname -I
ip addr
```

On macOS, use `ipconfig getifaddr en0`. On Windows, use `ipconfig`.

## Updating

From the repo directory:

```bash
git pull
pnpm install
pnpm app restart
```

`pnpm app restart` restarts production. Use `pnpm app restart all` to restart only the modes that are already running.

Session exports are encrypted with a passphrase entered in the transfer dialog. Use that passphrase when importing the archive on another host. See [Moving sessions between hosts](usage.md#moving-sessions-between-hosts).

## Troubleshooting

- QR scan button missing on phone: confirm the phone opened an `https://` URL and trusts the muxpilot root CA.
- Connection refused: confirm `MUXPILOT_LAN_ENABLED=1`, the phone is on the same network, and the desktop firewall allows the web port.
- Native Linux: use [Native Linux LAN Access](./linux-lan.md) to install and verify the required local firewall rule.
- Windows 11 + WSL2: use [Windows WSL LAN Access](./windows-wsl-lan.md) to install and verify the required Windows/Hyper-V firewall rules.
- Access key rejected: open the Connect device modal on the host machine and use the current generated access key.
- Skill suggestions missing: confirm `MUXPILOT_CODEX_HOME` or `MUXPILOT_CLAUDE_CONFIG_DIR` points at the provider home that contains your skills/plugins.
- Provider unavailable or signed out: run `pnpm app status` for each provider's availability, install anything the status names, and sign in on the host with `codex login` or `claude auth login`.
- Stale PID or port conflict: run `pnpm app status`, inspect `data/runtime/<mode>/`, and stop the conflicting process before starting again.
- Submitted input is preserved but blocked: open the session's `input_failed` banner and retry only after checking the live composer, or dismiss it without assuming the provider received it.
- Heavy command appears stuck: open the heavyweight-command indicator for queue/run state, recent output, process/container activity, deadlines, and terminate control.
- Sessions missing after an unclean host shutdown: use the startup recovery dialog or restore the conversation from the New session History tab.

Production mode is for manual operator checks. Automated agent work should use `pnpm app start dev`.

For deeper operational diagnosis, see [Runtime Reliability](runtime-reliability.md).
