import { stopMode } from "./lifecycle.mjs";

await stopMode(process.argv[2] ?? "all");
