#!/usr/bin/env node

import { formatWorkspaceStatus } from "./helper-output.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-finish [--integrate-without-review | --status]\n");
  process.exit(0);
}

const supportedArguments = new Set(["--integrate-without-review", "--status"]);
const unknownArgument = process.argv.slice(2).find((argument) => !supportedArguments.has(argument));
if (unknownArgument) {
  process.stderr.write(`Unknown argument: ${unknownArgument}\n`);
  process.exit(2);
}
const allowUnreviewed = process.argv.includes("--integrate-without-review");

const baseUrl = process.env.MUXPILOT_GIT_HELPER_URL;
const workspaceId = process.env.MUXPILOT_GIT_WORKSPACE_ID;
const token = process.env.MUXPILOT_GIT_HELPER_TOKEN;
if (!baseUrl || !workspaceId || !token) {
  process.stderr.write("This command is only available inside a muxpilot-managed Git session.\n");
  process.exit(2);
}

if (process.argv.includes("--status")) {
  const response = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/status`, {
    headers: { "x-muxpilot-git-token": token }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    process.stderr.write(`${payload.code ? `${payload.code}: ` : ""}${payload.error ?? `Status failed with HTTP ${response.status}`}\n`);
    process.exit(1);
  }
  process.stdout.write(`${formatWorkspaceStatus(payload.workspace)}\n`);
  process.exit(0);
}

process.stdout.write("FINALIZATION_STARTED\n");
const finalizeRequest = fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/finalize`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-muxpilot-git-token": token
  },
  body: JSON.stringify({ allowUnreviewed })
});
let lastPhase = null;
let lastProgressAt = Date.now();
let polling = false;
const progressTimer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const statusResponse = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/status`, {
      headers: { "x-muxpilot-git-token": token }
    });
    const statusPayload = await statusResponse.json().catch(() => ({}));
    const phase = statusPayload.workspace?.finalization?.status;
    if (statusResponse.ok && phase && phase !== lastPhase) {
      process.stdout.write(`FINALIZATION_PROGRESS phase=${phase}\n`);
      lastPhase = phase;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= 30_000) {
      process.stdout.write(`FINALIZATION_WAITING phase=${phase ?? lastPhase ?? "unknown"}\n`);
      lastProgressAt = Date.now();
    }
  } catch {
    if (Date.now() - lastProgressAt >= 30_000) {
      process.stdout.write(`FINALIZATION_WAITING phase=${lastPhase ?? "unknown"}\n`);
      lastProgressAt = Date.now();
    }
  } finally {
    polling = false;
  }
}, 1_000);
const response = await finalizeRequest.finally(() => clearInterval(progressTimer));
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  if (payload.code === "review_failed") {
    process.stdout.write("REVIEW_INCOMPLETE\n");
    process.stdout.write(`${payload.detail ?? payload.error ?? "Independent review did not complete."}\n`);
    process.stdout.write("Stop and tell the user that independent review is incomplete. Ask whether integration should proceed without successful review.\n");
    process.stdout.write("Only after explicit user approval, rerun the finish helper with --integrate-without-review.\n");
    process.exit(4);
  }
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
const reviewStatus = payload.reviewed === false ? " review=bypassed" : " review=passed";
process.stdout.write(`INTEGRATED managed_ref=${payload.workspace?.reconciliation?.managedRef ?? "unknown"} managed_sha=${payload.targetSha} generation=${payload.generation}${reviewStatus} worktree=removed\n`);
process.stdout.write(`${formatWorkspaceStatus(payload.workspace)}\n`);
