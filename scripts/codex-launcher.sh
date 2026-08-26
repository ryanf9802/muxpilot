#!/usr/bin/env bash

set +e

readonly max_attempts=3
readonly startup_window_seconds=15
readonly child_supervisor="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/codex-child-supervisor.mjs"
attempt=1

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -eq 0 ]]; then
  printf '\033]2;Codex startup failed\007'
  printf 'MUXPILOT_CODEX_STARTUP_FAILED code=127 attempts=0\n' >&2
  exec sleep infinity
fi

while true; do
  started_at=$SECONDS
  node "$child_supervisor" "$$" &
  supervisor_pid=$!
  "$@"
  exit_code=$?
  kill -TERM "$supervisor_pid" 2>/dev/null
  wait "$supervisor_pid" 2>/dev/null
  elapsed_seconds=$((SECONDS - started_at))

  if [[ $exit_code -eq 0 ]]; then
    exit 0
  fi

  if [[ $exit_code -eq 130 || $exit_code -eq 143 ]]; then
    exit "$exit_code"
  fi

  if [[ $attempt -lt $max_attempts && $elapsed_seconds -le $startup_window_seconds && $exit_code -ne 126 && $exit_code -ne 127 ]]; then
    printf '\nMUXPILOT_CODEX_STARTUP_RETRY attempt=%d code=%d\n' "$attempt" "$exit_code" >&2
    sleep "$attempt"
    attempt=$((attempt + 1))
    continue
  fi

  printf '\033]2;Codex startup failed\007'
  printf '\nMUXPILOT_CODEX_STARTUP_FAILED code=%d attempts=%d\n' "$exit_code" "$attempt" >&2
  printf 'Codex did not start. Muxpilot is keeping this pane open so the failure remains available.\n' >&2
  exec sleep infinity
done
