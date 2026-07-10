#!/usr/bin/env node

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-finish\n");
  process.exit(0);
}

const baseUrl = process.env.MUXPILOT_GIT_HELPER_URL;
const workspaceId = process.env.MUXPILOT_GIT_WORKSPACE_ID;
const token = process.env.MUXPILOT_GIT_HELPER_TOKEN;
if (!baseUrl || !workspaceId || !token) {
  process.stderr.write("This command is only available inside a muxpilot-managed Git session.\n");
  process.exit(2);
}

const response = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/finalize`, {
  method: "POST",
  headers: { "x-muxpilot-git-token": token }
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  process.stderr.write(`${payload.code ? `${payload.code}: ` : ""}${payload.error ?? `Finalize failed with HTTP ${response.status}`}\n`);
  process.exit(1);
}
if (payload.status === "changes_requested") {
  process.stdout.write(`CHANGES_REQUESTED\n${payload.summary ?? "Review requested changes."}\n`);
  for (const finding of payload.findings ?? []) {
    const location = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : "";
    process.stdout.write(`- ${finding.title}${location}: ${finding.body}\n`);
  }
  process.exit(3);
}
process.stdout.write(`INTEGRATED ${payload.targetSha} generation=${payload.generation}\n`);
