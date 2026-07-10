#!/usr/bin/env node

const input = process.argv[2]?.trim();
if (!input || input === "--help" || input === "-h") {
  process.stdout.write("Usage: muxpilot-git-inspect <remote/branch|local:branch|tag:name|full-commit-sha>\n");
  process.exit(input ? 0 : 2);
}

const baseUrl = process.env.MUXPILOT_GIT_HELPER_URL;
const workspaceId = process.env.MUXPILOT_GIT_WORKSPACE_ID;
const token = process.env.MUXPILOT_GIT_HELPER_TOKEN;
if (!baseUrl || !workspaceId || !token) {
  process.stderr.write("This command is only available inside a muxpilot-managed Git session.\n");
  process.exit(2);
}

const revision = parseRevision(input);
const response = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/inspections`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-muxpilot-git-token": token },
  body: JSON.stringify(revision)
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  process.stderr.write(`${payload.error ?? `Inspection request failed with HTTP ${response.status}`}\n`);
  process.exit(1);
}
const inspection = payload.workspace?.inspections?.at(-1);
if (!inspection) {
  process.stderr.write("Muxpilot did not return the created inspection.\n");
  process.exit(1);
}
process.stdout.write(`${inspection.commitSha} ${inspection.resolvedRef}\n`);

function parseRevision(value) {
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) return { kind: "commit", oid: value.toLowerCase() };
  if (value.startsWith("local:")) return { kind: "local_branch", branch: value.slice(6) };
  if (value.startsWith("tag:")) return { kind: "local_tag", tag: value.slice(4) };
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Remote branches must use <remote>/<branch> syntax.");
  return { kind: "remote_branch", remote: value.slice(0, slash), branch: value.slice(slash + 1) };
}
