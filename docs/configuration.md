# Configuration Reference

muxpilot is a single-operator developer console. The Web UI runs in a browser, and the Backend/API server is the trusted process that talks to tmux and Codex on the host machine.

## User Settings

- `MUXPILOT_LAN_ENABLED`: set to `1`, `true`, `yes`, or `on` to expose the backend and Web UI on the local network for phone access. Defaults to loopback-only local access.
- `OPENAI_API_KEY`: optional. Enables prompt-only activity summaries and OpenAI usage/cost tracking for dashboard cards.

The run scripts load `.env` first and `.env.local` second. Local setup helpers such as `pnpm pwa:setup` write machine-specific settings to `.env.local`, which is ignored by git.

## LAN Example

```bash
MUXPILOT_LAN_ENABLED=1 pnpm run:dev
```

Open the desktop web UI, press the Connect device button, and use the generated access key or QR code from the modal on your phone.

By default, the backend generates an in-memory remote access key and cookie signing secret on startup. Existing browser access sessions are invalidated after a backend restart, and remote access can also be revoked immediately from the Connect device modal.

If `MUXPILOT_LAN_ENABLED` is false and the app is bound to loopback, local browser requests are trusted and no access key is required.

## Persistence

The SQLite database lives on the Backend/API server host. It is not part of the Web UI bundle and should not be stored in `dist/`.

Development uses `./data/dev/muxpilot.db`. Production preview uses `./data/prod/muxpilot.db`. Startup creates missing directories but does not overwrite an existing database.

For a durable install outside the repo, configure:

```bash
MUXPILOT_DATA_DIR="$HOME/.local/share/muxpilot"
MUXPILOT_DB_PATH="$HOME/.local/share/muxpilot/muxpilot.db"
```

## Advanced Settings

These are available for unusual local setups but are not needed for normal desktop or LAN use:

- `MUXPILOT_HOST`: override backend bind host. Defaults to `127.0.0.1`, or `0.0.0.0` when LAN is enabled.
- `MUXPILOT_PORT`: backend port, default `4177` in development and `12777` in production preview.
- `MUXPILOT_WEB_PROTOCOL`: published Web UI protocol, `http` or `https`. The run scripts set this to `https` automatically when both local HTTPS certificate variables are configured.
- `MUXPILOT_WEB_PORT`: Web UI port, default `5177` in development and `12778` in production preview.
- `MUXPILOT_HTTPS_CERT`: optional certificate path for Vite dev/preview HTTPS.
- `MUXPILOT_HTTPS_KEY`: optional private key path for Vite dev/preview HTTPS. Must be set with `MUXPILOT_HTTPS_CERT`.
- `MUXPILOT_PWA_CA_DIR`: optional override for the shared local root CA directory used by `pnpm pwa:setup`. Normal use should put shared CA files in `.certs/pwa-ca/` instead.
- `MUXPILOT_PWA_TRUST_PORT`: optional port for `pnpm pwa:trust`, default `12880`.
- `MUXPILOT_API_TARGET`: Vite proxy target for `/api`, defaulting to the local backend port selected by the run script.
- `MUXPILOT_DATA_DIR`: data directory, default `./data/dev` under `pnpm run:dev`, `./data/prod` under `pnpm run:prod`, and `./data` when the server is started directly.
- `MUXPILOT_DB_PATH`: SQLite database path, default `./data/dev/muxpilot.db` under `pnpm run:dev`, `./data/prod/muxpilot.db` under `pnpm run:prod`, and `./data/muxpilot.db` when the server is started directly.
- `MUXPILOT_CODEX_HOME`: Codex home on the host machine, default `$HOME/.codex`.
- `MUXPILOT_SESSION_SECRET`: optional HMAC secret for persistent operator cookies across restarts.
- `MUXPILOT_OPERATOR_TOKEN`: optional override for the generated remote access key. Normal LAN use should leave this unset.
- `MUXPILOT_CORS_ORIGINS`: comma-separated allowlist for credentialed cross-origin API use. Not required for the normal LAN flow.
- `MUXPILOT_LOG_LEVEL`: Pino log level, default `info`.
- `MUXPILOT_DISCOVERY_INTERVAL_MS`: tmux discovery interval, default `1000`.
- `MUXPILOT_PARSER_INTERVAL_MS`: Codex JSONL parse interval, default `1000`.
- `MUXPILOT_INPUT_SUBMIT_KEYS`: tmux keys sent after pasting a chat message, default `Enter`.
- `MUXPILOT_INPUT_MODE_CYCLE_KEYS`: legacy setting for older Codex builds; current muxpilot switches modes with Codex slash commands (`/plan` and `/default`).
- Plan-action and question-option buttons use Codex menu selection keys directly; they do not use `MUXPILOT_INPUT_SUBMIT_KEYS`.
- `MUXPILOT_APPROVAL_APPROVE_ONCE_KEYS`: tmux keys for approving once, default `Enter`.
- `MUXPILOT_APPROVAL_APPROVE_PREFIX_KEYS`: tmux keys for persistent prefix approval, default `Down Enter`.
- `MUXPILOT_APPROVAL_DENY_KEYS`: tmux keys for denying/canceling an approval, default `Escape`.
- `MUXPILOT_SUMMARY_MODEL`: OpenAI model for activity summaries, default `gpt-4.1-mini`.
- `MUXPILOT_SUMMARY_INTERVAL_MS`: minimum per-session summary refresh interval, default `10000`.
- `MUXPILOT_SUMMARY_DEBOUNCE_MS`: debounce before refreshing after new messages, default `0`.
- `MUXPILOT_OPENAI_PRICING_JSON`: optional JSON object overriding OpenAI per-1M-token rates by model.

`MUXPILOT_OPENAI_PRICING_JSON` entries use this shape:

```json
{
  "model-name": {
    "inputUsdPerMillion": 0.8,
    "cachedInputUsdPerMillion": 0.2,
    "outputUsdPerMillion": 3.2
  }
}
```

The built-in pricing table covers `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano` family names used by the summary feature. Unknown models are recorded as unpriced instead of failing.
