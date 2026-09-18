# Deployment Guide


Do not expose muxpilot directly to the internet.

## Production Run

From a fresh clone:

```bash
git clone <muxpilot-repo-url>
cd muxpilot
pnpm install
cp .env.example .env
pnpm app start
```

`pnpm app start` runs the production path. It installs or updates all bundled muxpilot skills in `MUXPILOT_CODEX_HOME` (default `~/.codex`), builds the workspace, starts a repo-local supervisor in the background, starts the backend and web UI under that supervisor, and waits up to five minutes until both endpoints are healthy. Cold database and session recovery can take longer than ordinary startup, so the command reports endpoint readiness every 10 seconds while it waits. Skill synchronization also runs when production is already active.

Production defaults:

- Web UI: `http://127.0.0.1:12778`
- Backend: `http://127.0.0.1:12777`
- SQLite database: `./data/prod/muxpilot.db`
- Runtime state: `./data/runtime/prod/`
- Logs: `supervisor.log`, `server.log`, `web.log`
- PIDs: `supervisor.pid`, `server.pid`, `web.pid`


App-server Unix sockets live below `XDG_RUNTIME_DIR` so their paths remain within the platform limit even when muxpilot is installed in a deeply nested checkout. Durable environment metadata and protocol journals remain below `MUXPILOT_DATA_DIR`.

You can close the terminal after startup. The supervisor keeps running while the Linux/WSL instance stays running, and it restarts the backend or web process if one crashes. If the WSL distro, Linux session, or host machine stops, start muxpilot again with `pnpm app start`.

## Operations

```bash
pnpm app status
pnpm app logs
pnpm app logs prod --process all --follow
pnpm app restart
pnpm app stop
```

`pnpm app status` reports running, stopped, unmanaged, partial, unhealthy, stale PID, and port-conflict states for production and development.

`pnpm app restart all` and `pnpm restart` restart only modes that are already running. They do not start a stopped environment.

To remove unused transient event history and compact SQLite, stop production and run `pnpm db:compact:prod`. The command verifies the compacted copy before installing it and retains the original database as a timestamped backup.

The SQLite database is not the only durable state. Session documents and managed-session control state live beneath `MUXPILOT_GIT_SESSION_ROOT`; keep that root with the database when backing up an installation. Runtime PID/log directories and transient task worktrees can be recreated.

## Updating

```bash
git pull
pnpm install
pnpm app restart
```

Run `pnpm app status` after the restart and inspect `pnpm app logs prod --process all --lines 80` if either endpoint is unhealthy.

For an automated Codex change, local integration and production restart are separate operations. After the Git workflow reports `INTEGRATED`, use the repo-owned `$muxpilot-restart-prod` helper with the exact integrated commit. It moves outside the requesting session's resource scope, refuses a dirty or mismatched target checkout, restarts production, and verifies health, commit identity, and non-session cgroup placement. Human operators can continue to use `pnpm app restart prod` directly.

## LAN Run

Recommended defaults:

- Leave LAN disabled unless you need phone access.
- Use `MUXPILOT_LAN_ENABLED=1` for LAN access. The backend generates a remote access key at startup and shows it in the host-only Connect device modal.
- Keep the configured SQLite database backed up if transcripts, queued inputs, usage/cost records, summaries, or audit history matter.
- Keep `MUXPILOT_DB_PATH` outside build output such as `dist/`.
- Set `MUXPILOT_SESSION_SECRET` only if browser access sessions should survive backend restarts.
- Keep the passphrase used for each session export available to the operator who will import it.

Start bound to the LAN:

```bash
MUXPILOT_LAN_ENABLED=1 pnpm app start
```

Open the desktop app and use Connect device to get the phone URL.

If the phone cannot reach the URL, allow the Web UI port on the host firewall:

```bash
scripts/linux-lan.sh install --port 12778
scripts/linux-lan.sh status --port 12778
```

For Windows 11 + WSL2, use [Windows WSL LAN Access](./windows-wsl-lan.md). For native Linux details, use [Native Linux LAN Access](./linux-lan.md).

## LAN HTTPS For Phone Camera Access

Browser camera APIs require a secure context. `localhost` is treated as secure by browsers, but a phone opening `http://<lan-ip>:12778` is not. To use QR-code camera login from a phone, serve the Web UI over HTTPS with a certificate trusted by the phone.

Use the repo-local setup helper:

```bash
pnpm pwa:setup
pnpm app start
```

`pnpm pwa:setup` creates or reuses a muxpilot local root CA in `.certs/pwa-ca/`, issues a host certificate for the current LAN addresses, writes `.env.local` with `MUXPILOT_LAN_ENABLED=1`, `MUXPILOT_HTTPS_CERT`, `MUXPILOT_HTTPS_KEY`, and the public trust-file settings. When the backend starts in LAN mode, it also starts a small HTTP trust server that serves only public root CA/profile files for phones. The Connect device modal shows that install URL and QR code.

The setup command also attempts host trust. Under WSL it imports the CA into the Windows current-user Trusted Root store through PowerShell. On Linux it attempts the system CA store only when running as root; otherwise it prints the skipped step.

For multiple host machines, copy the shared CA files into `.certs/pwa-ca/` on the next host before running `pnpm pwa:setup`. Phones that already trust that CA should work with new host certificates issued from the same CA.

Keep `rootCA-key.pem` private. Anyone with that private CA key can issue certificates trusted by devices where the muxpilot root CA is installed.

When HTTPS certificate variables are set, `pnpm app start` serves the Vite preview over HTTPS, keeps the backend behind the same-origin `/api` proxy, publishes `https://` Connect device URLs, and publishes `http://` certificate install URLs. If the phone does not trust the certificate authority, the app may load after a browser warning, but camera APIs can still remain unavailable.

If the phone will install the certificate over LAN, the trust-server port must also be reachable:

```bash
scripts/linux-lan.sh install --port 12880
```

This production flow is for manual operator use only. Codex and other automated agents should use development mode with `pnpm app start dev`.

Cross-network access through VPNs, tunnels, reverse proxies, or static-hosted frontends is future work.

See [Runtime Reliability](runtime-reliability.md) for supervisor, reconciliation, input recovery, crash recovery, heavyweight scheduling, and resource-control behavior.
