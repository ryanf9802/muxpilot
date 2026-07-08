# Setup

Prerequisites:

- WSL2 Ubuntu
- tmux
- Node.js 24 or newer
- pnpm
- Codex CLI sessions already running in tmux

Install dependencies:

```bash
pnpm install
```

Create local config:

```bash
cp .env.example .env
```

Loopback local use does not require an access key. Before exposing the app to your LAN, set `MUXPILOT_LAN_ENABLED=1`.

Run development servers:

```bash
pnpm start:dev
```

`pnpm start:dev` checks the default/configured local ports first. If the backend and frontend are already active, it reuses the existing server instead of starting a second copy. When it starts a missing server, it runs it in the background with PID and log files under `data/runtime/dev/`. It uses `./data/dev/muxpilot.db` for local development state.

The backend binds to `127.0.0.1:4177` by default. The frontend runs on `127.0.0.1:5177`.

The dashboard shows discovered Codex/tmux panes grouped by repository. Session cards include status, repo/branch metadata, recent user prompts, optional prompt-only activity summaries, and usage data when available. Opening a session shows the structured transcript, raw terminal view, pending approvals/questions, queued input, skill suggestions, and session actions.

## Phone Access On The Same Network

For installable PWA use and QR-code camera login from a phone, generate local HTTPS certificates first:

```bash
pnpm pwa:setup
```

This creates or reuses the muxpilot local root CA, issues a host certificate for the current LAN addresses, writes the HTTPS settings to `.env.local`, and prepares public CA files for phone trust.

By default, the shared root CA lives in `.certs/pwa-ca/`. The directory exists in the repo as an ignored drop-in location: keep or copy `rootCA.pem` and `rootCA-key.pem` there if you want this host to use the same trusted CA as another muxpilot host. Do not commit or share `rootCA-key.pem` casually.

`pnpm pwa:setup` also tries to trust the root CA on the host. In WSL, it imports the CA into the Windows current-user Trusted Root store so Chrome/Edge treat `https://127.0.0.1:12778` and the LAN HTTPS URL as secure. If host trust is skipped, the command prints the reason and the browser may still show `ERR_CERT_AUTHORITY_INVALID`.

Start the app bound to the LAN:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm start:dev
```

Open the app on your desktop, press the Connect device button in the top bar, and open the shown URL on your phone. The URL usually looks like:

```text
https://192.168.1.25:5177
```

Use the Connect device modal on the host machine to copy the generated access key or scan the QR code. The phone browser talks to the Web UI over the LAN, and the backend controls tmux/Codex sessions on the desktop.

If HTTPS PWA certs are configured, the Connect device modal also shows an Install phone certificate URL and QR code. Open that first on the phone, install the public root CA, then open the HTTPS app URL. The private CA key is never served by the app. On iOS, enable full trust for the installed profile in Settings. On Android, install the CA certificate in user credentials.

By default, the backend generates an in-memory access key and cookie signing secret on startup. Existing phone/browser access sessions are invalidated after a backend restart. Set `MUXPILOT_SESSION_SECRET` only if you want browser access cookies to survive restarts when the access generation has not been revoked.

To find the LAN IP manually:

```bash
hostname -I
ip addr
```

On macOS, use `ipconfig getifaddr en0`. On Windows, use `ipconfig`.

Troubleshooting:

- QR scan button missing on phone: confirm the phone opened an `https://` URL and trusts the muxpilot root CA.
- Connection refused: confirm `MUXPILOT_LAN_ENABLED=1`, the phone is on the same network, and the desktop firewall allows the web port.
- Windows 11 + WSL2: use [Windows WSL LAN Access](./windows-wsl-lan.md) to install and verify the required Windows/Hyper-V firewall rules.
- Access key rejected: open the Connect device modal on the host machine and use the current generated access key.
- No sessions: confirm Codex is running inside tmux on the desktop user account that started the backend.
- Input not reaching Codex: confirm the tmux pane still exists and the backend user owns or can access that tmux socket.
- Skill suggestions missing: confirm `MUXPILOT_CODEX_HOME` points at the Codex home that contains your skills/plugins.

Run production preview:

```bash
pnpm start:prod
```

Production preview uses `127.0.0.1:12777` and `127.0.0.1:12778`, with a separate SQLite database under `./data/prod`, so it can run at the same time as the development server. If both production-preview endpoints are already healthy, `pnpm start:prod` reuses them instead of starting a duplicate. Started processes run in the background with PID and log files under `data/runtime/prod/`.

Stop production preview with `pnpm stop:prod`. Restart it with `pnpm restart:prod`. `pnpm stop` stops both development and production-preview listeners.

Production preview is for manual operator checks. Automated agent work should use `pnpm start:dev`.
