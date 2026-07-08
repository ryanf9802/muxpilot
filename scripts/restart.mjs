import { startMode, stopMode } from "./lifecycle.mjs";

const mode = process.argv[2];

if (!["dev", "prod"].includes(mode)) {
  console.error("Usage: node scripts/restart.mjs [dev|prod]");
  process.exit(1);
}

await stopMode(mode);
await startMode(mode);
