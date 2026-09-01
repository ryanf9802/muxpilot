#!/usr/bin/env node

import { readFile, readdir, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function main() {
  const rootPid = Number.parseInt(process.argv[2] ?? "", 10);
  const observationIntervalMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_OBSERVATION_MS, 250);
  const stableChildMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_STABLE_MS, 2_000);
  const startupLearningMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_LEARNING_MS, 15_000);
  const terminationGraceMs = positiveNumber(process.env.MUXPILOT_CODEX_CHILD_TERMINATION_GRACE_MS, 2_000);

  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) process.exit(2);

  const state = new ChildSupervisorState();
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

    const childRecords = (await Promise.all((await readChildren(runtimePid)).map(readProcess))).filter(Boolean);
    await state.pruneExited(childRecords, readProcess);
    const stale = state.reconcile(childRecords, {
      now: Date.now(),
      learningStartedAt,
      stableChildMs,
      startupLearningMs
    });
    for (const processRecord of stale) {
      state.forget(processRecord.pid);
      await terminateTree(processRecord, terminationGraceMs);
    }

    await delay(observationIntervalMs);
  }

  for (const processRecord of state.managedProcesses.values()) await terminateTree(processRecord, terminationGraceMs);
}

export class ChildSupervisorState {
  seenAt = new Map();
  managedCommands = new Set();
  managedProcesses = new Map();

  reconcile(childRecords, { now, learningStartedAt, stableChildMs, startupLearningMs }) {
    for (const child of childRecords) this.seenAt.set(child.pid, this.seenAt.get(child.pid) ?? now);
    const stable = childRecords.filter((child) => now - this.seenAt.get(child.pid) >= stableChildMs);

    for (const child of stable) {
      if (this.seenAt.get(child.pid) - learningStartedAt <= startupLearningMs) {
        this.managedCommands.add(child.command);
      }
    }

    const byCommand = new Map();
    for (const child of stable) {
      if (!this.managedCommands.has(child.command)) continue;
      const group = byCommand.get(child.command) ?? [];
      group.push(child);
      byCommand.set(child.command, group);
    }

    const stale = [];
    for (const group of byCommand.values()) {
      // Reconcile the whole command group every time so a previously incomplete
      // /proc snapshot cannot permanently bless two identical tool servers.
      group.sort((left, right) => isOlder(left, right) ? 1 : isOlder(right, left) ? -1 : 0);
      const [newest, ...older] = group;
      this.managedProcesses.set(newest.pid, newest);
      for (const child of older) {
        this.managedProcesses.delete(child.pid);
        stale.push(child);
      }
    }
    return stale;
  }

  async pruneExited(childRecords, processReader) {
    const visiblePids = new Set(childRecords.map((child) => child.pid));
    for (const pid of this.seenAt.keys()) {
      if (!visiblePids.has(pid) && !await processReader(pid)) this.forget(pid);
    }
  }

  forget(pid) {
    this.seenAt.delete(pid);
    this.managedProcesses.delete(pid);
  }
}

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
  const taskRoot = `/proc/${pid}/task`;
  // Native Codex worker threads can own child processes independently of the
  // thread-group leader, so union every task's immediate child list.
  const tids = await readdir(taskRoot).catch(() => []);
  const values = await Promise.all(tids.map((tid) =>
    readFile(`${taskRoot}/${tid}/children`, "utf8").catch(() => "")
  ));
  return [...new Set(values.flatMap((value) => value.trim().split(/\s+/).filter(Boolean).map(Number)))];
}

async function terminateTree(processRecord, terminationGraceMs) {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
