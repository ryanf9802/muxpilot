# Repository validation requirements

For every repository change, run focused tests and checks for the affected files or modules, then run the full production build from the task worktree before integration:

```sh
node "$MUXPILOT_GIT_HELPER_DIR/muxpilot-git-run.mjs" --heavy -- node scripts/build-worktree.mjs
```

This worktree-safe command runs the same core, server, and web compilation and web production bundle as `pnpm build` without asking pnpm to manage shared dependency links. The production build is required for every change, including test-only and documentation-only changes. It must succeed against the final committed candidate. Any subsequent repository change, rebase, or retarget invalidates the result and requires the build and complete self-review to be repeated.

Do not integrate when the build failed, was queued but did not run, is still running, or was skipped, including when the failure appears unrelated or pre-existing. Preserve the task worktree and report the blocker. Follow the muxpilot heavyweight-command queue and deferred-continuation procedure when the wrapper does not return a terminal result.

Completion reports must identify the integrated commit and state which focused checks and production build succeeded. A successful build does not authorize or prove a production restart; deployment and runtime health verification remain separate operations.
