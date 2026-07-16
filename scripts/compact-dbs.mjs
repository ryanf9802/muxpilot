import { constants, existsSync } from "node:fs";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { supervisorConfig } from "./lifecycle.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const serverRoot = resolve(projectRoot, "apps/server");

export async function compactDatabase(dbPath, options = {}) {
  const absolutePath = resolve(dbPath);
  if (!existsSync(absolutePath)) throw new Error(`Database does not exist: ${absolutePath}`);

  const suffix = (options.timestamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const backupPath = options.backupPath ?? `${absolutePath}.backup-${suffix}`;
  if (existsSync(backupPath)) throw new Error(`Backup already exists: ${backupPath}`);
  const workingPath = `${absolutePath}.compact-${process.pid}-${Date.now()}`;
  let sourceMoved = false;

  checkpointDatabase(absolutePath);
  const beforeBytes = (await stat(absolutePath)).size;

  try {
    await cloneFile(absolutePath, workingPath);
    const eventRowsRemoved = compactWorkingCopy(workingPath);
    await removeSidecars(absolutePath);
    await rename(absolutePath, backupPath);
    sourceMoved = true;
    try {
      await rename(workingPath, absolutePath);
    } catch (error) {
      await rename(backupPath, absolutePath);
      sourceMoved = false;
      throw error;
    }
    sourceMoved = false;

    return {
      dbPath: absolutePath,
      backupPath,
      beforeBytes,
      afterBytes: (await stat(absolutePath)).size,
      eventRowsRemoved
    };
  } finally {
    await removeDatabaseFiles(workingPath);
    if (sourceMoved && !existsSync(absolutePath) && existsSync(backupPath)) {
      await rename(backupPath, absolutePath);
    }
  }
}

function checkpointDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function compactWorkingCopy(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    const eventsTable = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", "events");
    const eventRowsRemoved = eventsTable
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count ?? 0)
      : 0;
    if (eventsTable) db.exec("DELETE FROM events");
    db.exec("VACUUM");
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`Compacted database failed integrity check: ${JSON.stringify(integrity)}`);
    }
    return eventRowsRemoved;
  } finally {
    db.close();
  }
}

async function cloneFile(from, to) {
  try {
    await copyFile(from, to, constants.COPYFILE_FICLONE);
  } catch {
    await rm(to, { force: true });
    await copyFile(from, to);
  }
}

async function removeSidecars(path) {
  await Promise.all([rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
}

async function removeDatabaseFiles(path) {
  await Promise.all([rm(path, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
}

async function main() {
  const mode = process.argv.includes("--dev") ? "dev" : "prod";
  const { config, urls } = supervisorConfig(mode);
  const occupied = await occupiedPorts([urls.backendPort, urls.webPort]);
  if (occupied.length > 0) {
    console.error(`Refusing to compact the ${mode} database while ports are active: ${occupied.join(", ")}.`);
    console.error(`Run pnpm app stop ${mode} first.`);
    process.exitCode = 1;
    return;
  }

  const configuredPath = process.env.MUXPILOT_DB_PATH ?? config.dbPath;
  const dbPath = resolve(serverRoot, configuredPath);
  const result = await compactDatabase(dbPath);
  console.log(`Compacted ${result.dbPath}`);
  console.log(`Removed ${result.eventRowsRemoved} transient event rows.`);
  console.log(`Database size: ${formatBytes(result.beforeBytes)} -> ${formatBytes(result.afterBytes)}.`);
  console.log(`Backup retained at ${result.backupPath}`);
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
    server.once("error", (error) => done(error.code === "EADDRINUSE"));
    server.once("listening", () => {
      listening = true;
      done(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 || unit === "B" ? 0 : 1)} ${unit}`;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
