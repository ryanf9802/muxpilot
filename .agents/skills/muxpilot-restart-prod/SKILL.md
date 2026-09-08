---
name: muxpilot-restart-prod
description: Restart muxpilot production after an integrated change, outside the current muxpilot session resource pool, and verify the exact deployed commit, health, and cgroup placement. Use when muxpilot server or web changes need to go live locally after they have been integrated into the target checkout.
---

# Muxpilot Production Restart

Use the bundled helper only after the implementation workflow has printed `INTEGRATED`. The helper refuses a dirty checkout or commit mismatch, then moves itself into a dedicated user-systemd restart scope before touching production.

## Run

1. Resolve the expected integrated commit with `git rev-parse HEAD` in the muxpilot target checkout.
2. Run the following command from that checkout with host/elevated execution so it can contact user systemd and move itself outside the muxpilot session cgroup:

   `node .agents/skills/muxpilot-restart-prod/scripts/restart-prod.mjs --expected-commit <sha>`

3. Treat `MUXPILOT_PROD_RESTARTED_OUTSIDE_SESSION_SCOPE` as the success marker. Report the supervisor, server, and web PIDs and their verified non-session cgroup placement.

The helper runs `pnpm app restart prod` directly inside its dedicated restart scope and removes inherited heavyweight queue, completion, broker, token, and run ownership variables. Production lifecycle must never enter the heavyweight scheduler: a deferred continuation would resume inside the requesting Codex session, skip the post-restart verifier, and allow the temporary worker scope to reap the production processes when it exits.

Do not call this helper from an implementation worktree, bypass `--expected-commit`, or substitute a raw lifecycle command. If host/elevated execution is unavailable, stop and ask for permission rather than starting production inside the session resource pool.
