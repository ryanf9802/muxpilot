---
name: muxpilot-start-shadow
description: Start an exact integrated muxpilot commit in an isolated shadow checkout outside the requesting session resource scope, while proving production process and session identities were not disturbed. Use for live app-server branch burn-in beside an active muxpilot production server.
---

# Muxpilot Shadow Start

Use this workflow only after the implementation workflow has printed `INTEGRATED`. It creates or reuses a dedicated checkout, installs dependencies there, moves the launcher into a user-systemd control scope, starts shadow mode, and verifies production before reporting success.

## Run

1. Resolve the exact integrated commit and confirm the production checkout is healthy.
2. Create a persistent detached worktree outside the requesting muxpilot session directory at a deliberately short path, such as `/home/user/mp-s`:

   `git -C <production-checkout> worktree add --detach <shadow-checkout> <expected-commit>`

   Reuse an existing clean checkout only when it is already at the exact expected commit. Do not switch the production checkout.
3. From the shadow checkout, run with host/elevated execution:

   `node .agents/skills/muxpilot-start-shadow/scripts/start-shadow.mjs --expected-commit <sha> --prod-checkout <production-checkout>`

   If a prior invocation completed its frozen installation but lost its deferred-command continuation before startup, the exact installed commit may be supplied once:

   `node .agents/skills/muxpilot-start-shadow/scripts/start-shadow.mjs --expected-commit <sha> --prod-checkout <production-checkout> --dependencies-installed-at <installed-sha>`

   This resume form fails closed unless the installed SHA is exact, is an ancestor of the requested commit, and no workspace package manifest, pnpm lock/workspace file, pnpm/npm install configuration, or patch artifact changed between them. It does not skip any production preflight or before/after identity comparison.

4. Treat `MUXPILOT_SHADOW_STARTED_OUTSIDE_SESSION_SCOPE` as the only success marker. Report production and shadow PIDs/cgroups plus the shadow URL.

The helper refuses a dirty or mismatched checkout, the production checkout itself, a different Git repository, any checkout too long for its owned Unix socket paths, a muxpilot session cgroup after relaunch, missing production health, changed production PIDs/cgroups, lost or replaced production tmux panes, changed existing app-server service identities, non-shadow health, and shadow children inside a muxpilot session cgroup. Once lifecycle startup is attempted, every later failure runs shadow-only cleanup before returning.

Do not replace the helper with raw `pnpm install` or `pnpm app start shadow` from the requesting session. Do not copy the production database, import an active production session, or point a test session at a production-controlled Codex thread.

Keep the detached checkout while shadow is running. Stop it from that checkout with `pnpm app stop shadow` under host/elevated execution before removing the worktree.
