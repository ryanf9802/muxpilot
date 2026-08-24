#!/usr/bin/env node
import { initializeStandalone, writeGitWorkflowEvent } from "./local-workflow.mjs";

const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const confirmed = process.argv.includes("--confirm-target");
const unknown = process.argv.slice(2).filter((value) => value.startsWith("--") && value !== "--confirm-target");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write("Usage: muxpilot-git-init <entry-path> <existing-local-target-branch> --confirm-target\n");
  process.exit(0);
}
if (unknown.length > 0 || positional.length !== 2 || !confirmed) {
  process.stderr.write("Standalone initialization requires an entry path, an existing local target branch, and --confirm-target after explicit user approval.\n");
  process.exit(2);
}

let config = null;
try {
  config = await initializeStandalone(positional[0], positional[1]);
  process.stdout.write(`STANDALONE_READY entry=${JSON.stringify(config.entryPath)} target=refs/heads/${config.targetBranch} sha=${config.targetSha} state=${JSON.stringify(config.statusFile)} reused=${config.reused}\n`);
  writeGitWorkflowEvent("workflow_initialized", "initialize", config, { targetSha: config.targetSha });
} catch (error) {
  writeGitWorkflowEvent("workflow_failed", "initialize", config, { error: error.message });
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
