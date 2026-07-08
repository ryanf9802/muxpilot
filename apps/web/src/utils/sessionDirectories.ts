import type { SessionDirectorySuggestion } from "@muxpilot/core";

export function directorySuggestionLabel(suggestion: SessionDirectorySuggestion): string {
  const branch = suggestion.branch ? ` · ${suggestion.branch}` : "";
  return `${suggestion.label}${branch} · ${suggestion.source}`;
}
