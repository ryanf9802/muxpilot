import { runningModes, startMode, stopMode } from "./lifecycle.mjs";

const mode = process.argv[2] ?? "all";

if (!["all", "dev", "prod"].includes(mode)) {
  console.error("Usage: node scripts/restart.mjs [all|dev|prod]");
  process.exit(1);
}

if (mode === "all") {
  const modes = runningModes("all");

  if (modes.length === 0) {
    console.log("No active local servers found. Leaving development and production preview down.");
    process.exit(0);
  }

  console.log(`Restarting active environments: ${modes.join(", ")}.`);

  for (const runningMode of modes) {
    await stopMode(runningMode);
  }

  for (const runningMode of modes) {
    await startMode(runningMode);
  }
} else {
  await stopMode(mode);
  await startMode(mode);
}
