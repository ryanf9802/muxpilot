---
name: muxpilot-restart-prod
description: Restart muxpilot production after an integrated change, outside the current muxpilot session resource pool, and verify the exact deployed commit, health, and cgroup placement. Use when muxpilot server or web changes need to go live locally after they have been integrated into the target checkout.
---

# Muxpilot Production Restart

Use the bundled helper only after the implementation workflow has printed `INTEGRATED`. The helper refuses a dirty checkout, a commit mismatch, or execution outside the host `/init.scope`.

## Run

1. Resolve the expected integrated commit with `git rev-parse HEAD` in the muxpilot target checkout.
2. Run the following command from that checkout with host/elevated execution so the command itself is outside the muxpilot session cgroup:

   `node .agents/skills/muxpilot-restart-prod/scripts/restart-prod.mjs --expected-commit <sha>`

3. Treat `MUXPILOT_PROD_RESTARTED_OUTSIDE_SESSION_SCOPE` as the success marker. Report the supervisor, server, and web PIDs and their verified `/init.scope` placement.

The helper remains attached in `/init.scope` while the heavyweight scheduler waits for a slot. It must never return a resumable raw `pnpm app restart prod` command to the requesting Codex session, because that would lose both host-scope placement and the post-restart verifier.

Do not call this helper from an implementation worktree, bypass `--expected-commit`, or substitute a raw lifecycle command. If host/elevated execution is unavailable, stop and ask for permission rather than starting production inside the session resource pool.
