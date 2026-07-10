#!/usr/bin/env node
import { formatWorkspaceStatus } from "./helper-output.mjs";

if (process.argv[2] !== "detach") {
  process.stderr.write("Usage: muxpilot-git-deps detach [relative-path ...]\n");
  process.exit(2);
}
const baseUrl = process.env.MUXPILOT_GIT_HELPER_URL;
const workspaceId = process.env.MUXPILOT_GIT_WORKSPACE_ID;
const token = process.env.MUXPILOT_GIT_HELPER_TOKEN;
if (!baseUrl || !workspaceId || !token) {
  process.stderr.write("This command is only available inside a muxpilot-managed Git session.\n");
  process.exit(2);
}
const paths = process.argv.slice(3);
const response = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/dependencies/detach`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-muxpilot-git-token": token },
  body: JSON.stringify({ paths: paths.length ? paths : null })
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  process.stderr.write(`${payload.code ? `${payload.code}: ` : ""}${payload.error ?? `Dependency detach failed with HTTP ${response.status}`}\n`);
  process.exit(1);
}
process.stdout.write(`DEPENDENCIES_DETACHED\n${formatWorkspaceStatus(payload.workspace)}\n`);
