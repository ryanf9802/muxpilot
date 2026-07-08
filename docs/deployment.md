# Deployment Guide

The supported deployment for this iteration is a developer-controlled host on a trusted LAN.

Recommended defaults:

- Leave LAN disabled unless you need phone access.
- Use `MUXPILOT_LAN_ENABLED=1` for LAN access. The backend generates a remote access key at startup and shows it in the host-only Connect device modal.
- Keep the configured SQLite database backed up if transcripts, queued inputs, usage/cost records, summaries, or audit history matter.
- Keep `MUXPILOT_DB_PATH` outside build output such as `dist/`.
- Set `MUXPILOT_SESSION_SECRET` only if browser access sessions should survive backend restarts.

Example production-ish run:

```bash
pnpm build
pnpm --filter @muxpilot/server start
```

When started directly this way, the backend defaults to `127.0.0.1:4177` and `./data/muxpilot.db` unless `MUXPILOT_PORT`, `MUXPILOT_DATA_DIR`, and `MUXPILOT_DB_PATH` are set. The Node process needs permission to connect to the tmux socket owned by the same OS/WSL user.

## LAN Run

```bash
MUXPILOT_LAN_ENABLED=1 pnpm start:prod
```

Open the desktop app and use Connect device to get the phone URL.

Stop production preview with `pnpm stop:prod`. Restart it with `pnpm restart:prod`. `pnpm stop` stops both development and production-preview listeners.

## LAN HTTPS For Phone Camera Access

Browser camera APIs require a secure context. `localhost` is treated as secure by browsers, but a phone opening `http://<lan-ip>:12778` is not. To use QR-code camera login from a phone, serve the Web UI over HTTPS with a certificate trusted by the phone.

Use the repo-local setup helper:

```bash
pnpm pwa:setup
pnpm start:prod
```

`pnpm pwa:setup` creates or reuses a muxpilot local root CA in `.certs/pwa-ca/`, issues a host certificate for the current LAN addresses, writes `.env.local` with `MUXPILOT_LAN_ENABLED=1`, `MUXPILOT_HTTPS_CERT`, `MUXPILOT_HTTPS_KEY`, and the public trust-file settings. When the backend starts in LAN mode, it also starts a small HTTP trust server that serves only public root CA/profile files for phones. The Connect device modal shows that install URL and QR code.

The setup command also attempts host trust. Under WSL it imports the CA into the Windows current-user Trusted Root store through PowerShell. On Linux it attempts the system CA store only when running as root; otherwise it prints the skipped step.

For multiple host machines, copy the shared CA files into `.certs/pwa-ca/` on the next host before running `pnpm pwa:setup`. Phones that already trust that CA should work with new host certificates issued from the same CA.

Keep `rootCA-key.pem` private. Anyone with that private CA key can issue certificates trusted by devices where the muxpilot root CA is installed.

When HTTPS certificate variables are set, `pnpm start:prod` serves the Vite preview over HTTPS, keeps the backend behind the same-origin `/api` proxy, publishes `https://` Connect device URLs, and publishes `http://` certificate install URLs. If the phone does not trust the certificate authority, the app may load after a browser warning, but camera APIs can still remain unavailable.

This production-preview flow is for manual operator use only. Codex and other automated agents must not run `pnpm start:prod` or stop production-preview servers with `pnpm stop:prod`, `pnpm restart:prod`, or `pnpm stop`; agents should use only the development server commands from the development guide.

Do not expose this directly to the internet. Cross-network access through VPNs, tunnels, reverse proxies, or static-hosted frontends is future work.
