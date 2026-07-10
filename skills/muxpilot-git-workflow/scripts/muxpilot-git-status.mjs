#!/usr/bin/env node
import { formatWorkspaceStatus } from "./helper-output.mjs";

const baseUrl = process.env.MUXPILOT_GIT_HELPER_URL;
const workspaceId = process.env.MUXPILOT_GIT_WORKSPACE_ID;
const token = process.env.MUXPILOT_GIT_HELPER_TOKEN;
if (!baseUrl || !workspaceId || !token) {
  process.stderr.write("This command is only available inside a muxpilot-managed Git session.\n");
  process.exit(2);
}
const response = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/status`, {
  headers: { "x-muxpilot-git-token": token }
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  process.stderr.write(`${payload.code ? `${payload.code}: ` : ""}${payload.error ?? `Status failed with HTTP ${response.status}`}\n`);
  process.exit(1);
}
process.stdout.write(`${formatWorkspaceStatus(payload.workspace)}\n`);
