#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] !== "--heavy" || args[1] !== "--" || args.length < 3) {
  fail("usage: muxpilot-git-run.mjs --heavy -- <command> [args...]");
}

const concurrency = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_CONCURRENCY, 2);
const leaseRoot = process.env.MUXPILOT_HEAVY_VALIDATION_DIR ?? join(tmpdir(), `muxpilot-heavy-validation-${process.getuid?.() ?? "user"}`);
const pollMs = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_POLL_MS, 250);
const staleMs = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_STALE_MS, 12 * 60 * 60 * 1000);
const command = args.slice(2);
let leasePath = null;
let child = null;
let stoppingSignal = null;
let exitSignal = null;
const signalHandlers = new Map();

await mkdir(leaseRoot, { recursive: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    stoppingSignal = signal;
    child?.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  leasePath = await acquireLease();
  child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  exitSignal = stoppingSignal ?? result.signal;
  process.exitCode = result.code ?? 1;
} finally {
  if (leasePath) await rm(leasePath, { recursive: true, force: true });
}
if (exitSignal) {
  for (const [name, handler] of signalHandlers) process.off(name, handler);
  process.kill(process.pid, exitSignal);
}

async function acquireLease() {
  while (true) {
    await reapStaleLeases();
    for (let slot = 0; slot < concurrency; slot += 1) {
      const candidate = join(leaseRoot, `slot-${slot}`);
      try {
        await mkdir(candidate);
        await writeFile(join(candidate, "owner.json"), JSON.stringify({
          pid: process.pid,
          processStart: processStart(process.pid),
          startedAt: Date.now(),
          cwd: process.cwd(),
          command
        }));
        return candidate;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await delay(pollMs);
  }
}

async function reapStaleLeases() {
  for (const entry of await readdir(leaseRoot).catch(() => [])) {
    if (!entry.startsWith("slot-")) continue;
    const path = join(leaseRoot, entry);
    try {
      const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      const alive = Number.isInteger(owner.pid) &&
        owner.pid > 0 &&
        processAlive(owner.pid) &&
        (!owner.processStart || owner.processStart === processStart(owner.pid));
      if (!alive) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      const details = await stat(path).catch(() => null);
      if (details && Date.now() - details.mtimeMs > staleMs) {
        await rm(path, { recursive: true, force: true });
      }
    }
  }
}

function processStart(pid) {
  try {
    const stat = requireProcStat(pid);
    const end = stat.lastIndexOf(")");
    return stat.slice(end + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

function requireProcStat(pid) {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
