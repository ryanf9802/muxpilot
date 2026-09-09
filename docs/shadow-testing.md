# Shadow Testing
Shadow mode runs a second muxpilot lane for app-server burn-in while production remains live. Start it from a dedicated checkout or Git worktree of the branch under test. Keep the checkout path short (for example `/home/user/mp-s`), because Linux Unix sockets have a 107-byte pathname limit; the Codex workflow validates every shadow-owned socket before installation or startup.

```bash
pnpm install --frozen-lockfile
pnpm app start shadow
pnpm app status shadow
pnpm app logs shadow --process all --follow
```

Open `http://localhost:15177` in the Windows or Linux browser. WSL localhost forwarding works the same way as it does for the normal muxpilot web UI.

Shadow startup refuses dependency links that resolve to another checkout. If the worktree was created by muxpilot and shares `node_modules` with production, use the Git workflow dependency-localization helper for its registered Node dependency paths before starting shadow mode; this prevents branch code from loading production's older core build.


If the helper reports that frozen installation completed but its deferred-command continuation is lost before startup, rerun it with `--dependencies-installed-at <exact-installed-sha>`. Installation is skipped only when that SHA is an ancestor of the requested commit and Git proves that package manifests, pnpm lock/workspace inputs, install configuration, and patch artifacts are unchanged. Startup still takes fresh production snapshots before and after launching shadow.

Shadow mode forcibly uses:

- loopback-only HTTP on backend port `14177` and web port `15177`;
- `data/shadow/muxpilot.db` and `data/runtime/shadow/` in the checkout that launched it;
- `data/shadow/git-worktrees/` and `data/shadow/sessions/` for managed Git and session documents;
- `data/shadow/heavy/` for heavyweight queue state;
- a shadow-namespaced app-server capability identity, so even a reused session ID cannot select a production unit;
- app-server as the sole session runtime.


App-server systemd services receive the launching muxpilot server's executable search path in their private environment file. This is required when `codex` and its Node interpreter are installed through a user-level version manager such as NVM.


These values override `.env` and `.env.local`. Shadow mode disables LAN/HTTPS exposure and resource governance by default, does not synchronize bundled skills into `~/.codex`, and does not read or copy the production database.

## Safety boundary

Create new sessions in the shadow UI. Do not copy the production database, restore a currently active production thread, or import a transfer made from an active production session. Any of those actions could create two controllers for the same Codex thread even though the muxpilot services themselves are isolated.

The harness isolates muxpilot-owned state; it does not make an arbitrary working directory read-only. A directory-mode session pointed at `../teamweave` will intentionally edit that real checkout and trigger its HMR. Use a scratch checkout or a managed Git session when the codebase must also remain isolated.

`pnpm app stop shadow` stops the shadow supervisor and only systemd units proven by metadata inside the shadow data tree. It preserves the shadow database and evidence so restart/recovery tests can continue later. It does not stop production or delete shadow data.

Resource governance and systemd-scoped child/heavy orchestration can be enabled for tests that need them:

```bash
MUXPILOT_SHADOW_RESOURCE_GOVERNOR=auto pnpm app restart shadow
```

That opt-in remains scoped to sessions and heavyweight work recorded by the shadow database and queue. It does consume real machine resources, so avoid simultaneous stress tests against production.

## Burn-in checklist

Use newly created shadow sessions for each check:

1. Start a session, send verified input, exercise multiline composer safeguards, and confirm transcript evidence.
2. Resume after hibernation, fork the session, interrupt a running turn, and kill a disposable session.
3. Exercise command/file approvals, questions, Implement, Clear context and implement, and Stay in plan mode.
4. Start a background terminal/HMR command and inspect raw runtime, process-tree, and protocol-journal evidence.
5. Create child sessions, wait for them, exercise context/budget guards, and confirm roll-up status. Enable the shadow resource governor first.
6. Create managed Git directory and worktree sessions, use documents/BTW/skills, and run one heavyweight command. Confirm all paths remain below `data/shadow/`.
7. Restart only the shadow backend with `pnpm app restart shadow`; verify session recovery, pending gates, failed-input handling, and hibernate/wake.
8. Export and import a disposable shadow session, then verify transfer mappings without involving an active production thread.
9. Compare memory for warm-idle, hibernated, active, background-terminal, and several concurrent shadow app-server sessions.
10. Run `pnpm app stop shadow`, confirm `pnpm app status prod` is unchanged, and verify no shadow-owned app-server or heavy unit remains active.
