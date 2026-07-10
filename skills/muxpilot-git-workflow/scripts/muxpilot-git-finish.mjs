#!/usr/bin/env node

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-finish [--integrate-without-review]\n");
  process.exit(0);
}

const supportedArguments = new Set(["--integrate-without-review"]);
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

const response = await fetch(`${baseUrl}/api/internal/git-workspaces/${encodeURIComponent(workspaceId)}/finalize`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-muxpilot-git-token": token
  },
  body: JSON.stringify({ allowUnreviewed })
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) {
  if (payload.code === "review_failed") {
    process.stdout.write("REVIEW_INCOMPLETE\n");
    process.stdout.write(`${payload.detail ?? payload.error ?? "Independent review did not complete."}\n`);
    process.stdout.write("Stop and tell the user that independent review is incomplete. Ask whether integration should proceed without successful review.\n");
    process.stdout.write("Only after explicit user approval, rerun: node \"$CODEX_HOME/skills/muxpilot-git-workflow/scripts/muxpilot-git-finish.mjs\" --integrate-without-review\n");
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
process.stdout.write(`INTEGRATED ${payload.targetSha} generation=${payload.generation}${reviewStatus}\n`);
