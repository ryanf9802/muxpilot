#!/usr/bin/env node

import { readFile, readlink } from "node:fs/promises";

const rootPid = Number.parseInt(process.argv[2] ?? "", 10);
const observationIntervalMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_OBSERVATION_MS, 250);
const stableChildMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_STABLE_MS, 2_000);
const startupLearningMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_LEARNING_MS, 15_000);
const terminationGraceMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_TERMINATION_GRACE_MS, 2_000);

if (!Number.isSafeInteger(rootPid) || rootPid <= 1) process.exit(2);

const seenAt = new Map();
const managedCommands = new Set();
const managedProcesses = new Map();
let runtimePid = null;
let learningStartedAt = null;
let stopping = false;

process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

while (!stopping && await processExists(rootPid)) {
  runtimePid ??= await findCodexRuntime(rootPid);
  if (runtimePid !== null && !await processExists(runtimePid)) break;
  if (runtimePid === null) {
    await delay(observationIntervalMs);
    continue;
  }
  learningStartedAt ??= Date.now();

  const now = Date.now();
  const children = await readChildren(runtimePid);
  const childRecords = (await Promise.all(children.map(readProcess))).filter(Boolean);
  const livePids = new Set(childRecords.map((child) => child.pid));
  for (const pid of seenAt.keys()) {
    if (!livePids.has(pid)) seenAt.delete(pid);
  }

  for (const child of childRecords) {
    seenAt.set(child.pid, seenAt.get(child.pid) ?? now);
    const firstSeenAt = seenAt.get(child.pid);
    if (now - firstSeenAt < stableChildMs) continue;

    if (firstSeenAt - learningStartedAt <= startupLearningMs) {
      managedCommands.add(child.command);
      managedProcesses.set(child.pid, child);
      continue;
    }

    if (!managedCommands.has(child.command) || managedProcesses.has(child.pid)) continue;
    // Codex starts stdio tool servers as durable direct children. Context
    // compaction can start an identical replacement without retiring the old
    // process, so only deduplicate command identities learned during startup.
    const stale = childRecords.filter((candidate) =>
      candidate.command === child.command
      && candidate.pid !== child.pid
      && isOlder(candidate, child)
    );
    if (stale.length === 0) {
      managedProcesses.set(child.pid, child);
      continue;
    }

    managedProcesses.set(child.pid, child);
    for (const processRecord of stale) {
      managedProcesses.delete(processRecord.pid);
      await terminateTree(processRecord);
    }
  }

  await delay(observationIntervalMs);
}

for (const processRecord of managedProcesses.values()) await terminateTree(processRecord);

async function findCodexRuntime(pid) {
  const pending = [pid];
  const visited = new Set();
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    const processRecord = await readProcess(candidate);
    if (!processRecord) continue;
    if (processRecord.name === "codex" || processRecord.executable === "codex") return candidate;
    pending.push(...await readChildren(candidate));
  }
  return null;
}

async function readProcess(pid) {
  try {
    const [stat, commandLine, executablePath] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`),
      readlink(`/proc/${pid}/exe`).catch(() => "")
    ]);
    const closeParen = stat.lastIndexOf(")");
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const command = commandLine.toString("utf8").replaceAll("\0", "\u0000").replace(/\u0000$/, "");
    if (!command) return null;
    return {
      pid,
      name: stat.slice(stat.indexOf("(") + 1, closeParen),
      executable: executablePath.split("/").at(-1) ?? "",
      startTime: Number.parseInt(fields[19] ?? "0", 10),
      command
    };
  } catch {
    return null;
  }
}

async function readChildren(pid) {
  try {
    const value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return value.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function terminateTree(processRecord) {
  if (!await sameProcess(processRecord)) return;
  const descendants = await collectDescendants(processRecord.pid);
  await signalAll([processRecord, ...descendants], "SIGTERM");
  const deadline = Date.now() + terminationGraceMs;
  while (Date.now() < deadline && await sameProcess(processRecord)) await delay(50);
  if (await sameProcess(processRecord)) await signalAll([...descendants.reverse(), processRecord], "SIGKILL");
}

async function collectDescendants(pid) {
  const result = [];
  const pending = [...await readChildren(pid)];
  while (pending.length > 0) {
    const child = pending.shift();
    const processRecord = await readProcess(child);
    if (!processRecord) continue;
    result.push(processRecord);
    pending.push(...await readChildren(child));
  }
  return result;
}

async function signalAll(processRecords, signal) {
  for (const processRecord of processRecords) {
    if (!await sameProcess(processRecord)) continue;
    try {
      process.kill(processRecord.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function sameProcess(expected) {
  const current = await readProcess(expected.pid);
  return current?.startTime === expected.startTime && current.command === expected.command;
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isOlder(candidate, replacement) {
  return candidate.startTime < replacement.startTime
    || (candidate.startTime === replacement.startTime && candidate.pid < replacement.pid);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
