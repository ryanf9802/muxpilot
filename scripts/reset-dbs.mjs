import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const modes = args.has("--dev") ? ["dev"] : args.has("--prod") ? ["prod"] : ["dev", "prod"];

const config = {
  dev: { ports: [4177, 5177], dbPath: "./data/dev/muxpilot.db" },
  prod: { ports: [12777, 12778], dbPath: "./data/prod/muxpilot.db" }
};

for (const mode of modes) {
  const entry = config[mode];
  if (!entry) continue;
  const occupied = await occupiedPorts(entry.ports);
  if (occupied.length > 0 && !force) {
    console.error(`Refusing to reset ${mode} DB while ports are active: ${occupied.join(", ")}`);
    console.error("Stop the server first or rerun with --force.");
    process.exit(1);
  }

  for (const path of dbFiles(entry.dbPath)) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    console.log(`Removed ${path}`);
  }
}

function dbFiles(path) {
  const absolute = resolve(path);
  return [absolute, `${absolute}-wal`, `${absolute}-shm`];
}

async function occupiedPorts(ports) {
  const checks = await Promise.all(ports.map(async (port) => ((await portOccupied(port)) ? port : null)));
  return checks.filter((port) => port !== null);
}

function portOccupied(port) {
  return new Promise((resolveOccupied) => {
    const server = createServer();
    let listening = false;
    const done = (occupied) => {
      server.removeAllListeners();
      if (listening) server.close(() => resolveOccupied(occupied));
      else resolveOccupied(occupied);
    };
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") done(true);
      else done(false);
    });
    server.once("listening", () => {
      listening = true;
      done(false);
    });
    server.listen(port, "127.0.0.1");
  });
}
