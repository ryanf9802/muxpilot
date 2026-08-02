#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const parsed = parseArguments(process.argv.slice(2));
const command = parsed.command;
const concurrency = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_CONCURRENCY, 2);
const leaseRoot = process.env.MUXPILOT_HEAVY_VALIDATION_DIR ?? join(tmpdir(), `muxpilot-heavy-validation-${process.getuid?.() ?? "user"}`);
const pollMs = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_POLL_MS, 250);
const staleMs = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_STALE_MS, 12 * 60 * 60 * 1000);
const consoleHeartbeatMs = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_CONSOLE_HEARTBEAT_MS, 30_000);
const ownerHeartbeatMs = positiveInteger(process.env.MUXPILOT_HEAVY_VALIDATION_OWNER_HEARTBEAT_MS, 15_000);
const inactivityWarnMs = duration(parsed.inactivityWarn, process.env.MUXPILOT_HEAVY_VALIDATION_INACTIVITY_WARN_MS, 60_000);
const inactivityTimeoutMs = duration(parsed.inactivityTimeout, process.env.MUXPILOT_HEAVY_VALIDATION_INACTIVITY_TIMEOUT_MS, 10 * 60_000);
const runtimeTimeoutMs = duration(parsed.runtimeTimeout, process.env.MUXPILOT_HEAVY_VALIDATION_RUNTIME_TIMEOUT_MS, 30 * 60_000);
const terminationGraceMs = duration(parsed.terminationGrace, process.env.MUXPILOT_HEAVY_VALIDATION_TERMINATION_GRACE_MS, 30_000);
const runId = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
const workspaceId = process.env.MUXPILOT_GIT_WORKSPACE_ID ?? null;
const runDir = join(leaseRoot, "runs", runId);
const controlSocket = join(runDir, "control.sock");
const startedWaitingAt = Date.now();
let state = "waiting";
let slot = null;
let leasePath = null;
let child = null;
let childOutcome = null;
let childStartedAt = null;
let lastOutputAt = null;
let lastActivityAt = null;
let activity = { processCount: 0, cpuTicks: 0, ioBytes: 0, runningContainers: 0, createdContainers: 0 };
let previousActivity = null;
let lastDockerSampleAt = 0;
let dockerActivity = { runningContainers: 0, createdContainers: 0 };
let warned = false;
let terminationReason = null;
let desiredExitCode = null;
let stoppingSignal = null;
let forced = false;
let packageDiagnostics = null;
let log = null;
let server = null;
let heartbeatTimer = null;
let consoleTimer = null;
let watchdogTimer = null;
let forceTimer = null;
let ownerWrite = Promise.resolve();

await mkdir(runDir, { recursive: true, mode: 0o700 });
await chmod(runDir, 0o700);
log = await createRunLog();
server = await createControlServer();
await updateOwner();
lifecycle("WAITING_FOR_SLOT", `run=${runId} command=${formatCommand(command)}`);
heartbeatTimer = setInterval(() => void updateOwner(), ownerHeartbeatMs);
consoleTimer = setInterval(() => {
  const now = Date.now();
  if (!childStartedAt) {
    lifecycle("WAITING_FOR_SLOT", `run=${runId} waited=${formatElapsed(now - startedWaitingAt)}`);
    return;
  }
  lifecycle("RUNNING", `run=${runId} elapsed=${formatElapsed(now - childStartedAt)} output_silent=${formatElapsed(now - lastOutputAt)} progress_idle=${formatElapsed(now - lastActivityAt)} state=${state} processes=${activity.processCount} containers=${activity.runningContainers}`);
}, consoleHeartbeatMs);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stoppingSignal ??= signal;
    if (child) requestTermination(`wrapper received ${signal}`, null);
  });
}

try {
  const acquired = await acquireLease();
  leasePath = acquired.path;
  slot = acquired.slot;
  state = "running";
  const acquiredAt = Date.now();
  packageDiagnostics = inspectPackageManager();
  lifecycle("LEASE_ACQUIRED", `run=${runId} slot=${slot} waited=${formatElapsed(acquiredAt - startedWaitingAt)}`);
  for (const message of packageDiagnostics.messages) lifecycle(message.level, message.text);
  childStartedAt = Date.now();
  lastOutputAt = childStartedAt;
  lastActivityAt = childStartedAt;

  const jsiiCache = await prepareJsiiCache();
  if (jsiiCache.fallback) lifecycle("CACHE_FALLBACK", `name=JSII_RUNTIME_PACKAGE_CACHE_ROOT path=${jsiiCache.path} reason=${jsiiCache.reason}`);

  const childEnvironment = {
    ...process.env,
    DOCKER_CUSTOM_HEADERS: appendDockerHeader(
      appendDockerHeader(process.env.DOCKER_CUSTOM_HEADERS, "X-Muxpilot-Heavy-Run", runId),
      "X-Muxpilot-Workspace", workspaceId
    ),
    MUXPILOT_HEAVY_RUN_ID: runId,
    JSII_RUNTIME_PACKAGE_CACHE_ROOT: jsiiCache.path
  };
  child = spawn(resolveExecutable(command[0]) ?? command[0], command.slice(1), {
    cwd: process.cwd(),
    env: childEnvironment,
    detached: true,
    stdio: ["inherit", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => relayChildOutput(process.stdout, chunk));
  child.stderr.on("data", (chunk) => relayChildOutput(process.stderr, chunk));
  child.once("spawn", () => lifecycle("COMMAND_STARTED", `run=${runId} pid=${child.pid} slot=${slot}`));
  const childResult = new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  await updateOwner();

  watchdogTimer = setInterval(runWatchdog, Math.min(1_000, Math.max(25, Math.floor(inactivityWarnMs / 4))));

  const result = await childResult;
  childOutcome = result;
  clearRuntimeTimers();
  lifecycle("COMMAND_EXITED", `run=${runId} code=${result.code ?? "null"} signal=${result.signal ?? "none"}`);
  if ((result.code === 137 || result.signal === "SIGKILL") && !forced) diagnoseResourceExit();
  process.exitCode = desiredExitCode ?? result.code ?? (result.signal ? 1 : 0);
} catch (error) {
  lifecycle("RUNNER_ERROR", error instanceof Error ? error.message : String(error));
  process.exitCode = desiredExitCode ?? 1;
} finally {
  clearRuntimeTimers();
  if (terminationReason || (process.exitCode ?? 0) !== 0) await cleanupDockerContainers();
  if (leasePath) {
    await rm(leasePath, { recursive: true, force: true });
    lifecycle("LEASE_RELEASED", `run=${runId} slot=${slot}`);
  }
  await finalizeRun();
  await new Promise((resolveClose) => server?.close(resolveClose));
  await rm(controlSocket, { force: true });
  await pruneRunRecords();
  if (stoppingSignal && desiredExitCode === null) {
    process.removeAllListeners(stoppingSignal);
    process.kill(process.pid, stoppingSignal);
  }
}

function parseArguments(args) {
  if (args[0] !== "--heavy") fail("usage: muxpilot-git-run.mjs --heavy [timeout flags] -- <command> [args...]");
  const result = {};
  let index = 1;
  const flags = new Map([
    ["--inactivity-warn", "inactivityWarn"],
    ["--inactivity-timeout", "inactivityTimeout"],
    ["--runtime-timeout", "runtimeTimeout"],
    ["--termination-grace", "terminationGrace"]
  ]);
  while (index < args.length && args[index] !== "--") {
    const name = flags.get(args[index]);
    if (!name || !args[index + 1]) fail(`unknown or incomplete option: ${args[index]}`);
    result[name] = args[index + 1];
    index += 2;
  }
  if (args[index] !== "--" || index + 1 >= args.length) fail("usage: muxpilot-git-run.mjs --heavy [timeout flags] -- <command> [args...]");
  result.command = args.slice(index + 1);
  return result;
}

async function createControlServer() {
  const control = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n") && input.length < 4096) return;
      try {
        const request = JSON.parse(input.trim());
        if (request.action === "probe") socket.end(`${JSON.stringify({ ok: true, runId, state })}\n`);
        else if (request.action === "terminate") {
          const accepted = (state === "waiting" || Boolean(child)) && state !== "terminating";
          if (accepted && state === "waiting") {
            state = "terminating";
            terminationReason = "operator requested termination while waiting for a slot";
            desiredExitCode = 143;
            stoppingSignal = "SIGTERM";
            lifecycle("TERMINATING", `run=${runId} reason=${terminationReason}`);
            void updateOwner();
          } else if (accepted) requestTermination("operator requested termination", 143);
          socket.end(`${JSON.stringify({ ok: true, accepted, state: accepted ? "terminating" : state })}\n`);
        } else socket.end(`${JSON.stringify({ ok: false, error: "unsupported action" })}\n`);
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: "invalid request" })}\n`);
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    control.once("error", reject);
    control.listen(controlSocket, resolveListen);
  });
  await chmod(controlSocket, 0o600);
  return control;
}

async function acquireLease() {
  while (!stoppingSignal) {
    await reapStaleLeases();
    for (let candidateSlot = 0; candidateSlot < concurrency; candidateSlot += 1) {
      const candidate = join(leaseRoot, `slot-${candidateSlot}`);
      try {
        await mkdir(candidate);
        await writeFile(join(candidate, "owner.json"), JSON.stringify({ version: 2, runId, controlSocket, heartbeatAt: Date.now() }), { mode: 0o600 });
        return { path: candidate, slot: candidateSlot };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await delay(pollMs);
  }
  throw new Error(`stopped while waiting for a heavyweight slot (${stoppingSignal})`);
}

async function reapStaleLeases() {
  for (const entry of await readdir(leaseRoot).catch(() => [])) {
    if (!entry.startsWith("slot-")) continue;
    const path = join(leaseRoot, entry);
    try {
      const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      if (owner.version === 2 && validSocketPath(owner.controlSocket)) {
        if (!await probeSocket(owner.controlSocket)) await rm(path, { recursive: true, force: true });
        continue;
      }
      const timestamp = Number(owner.heartbeatAt ?? owner.startedAt);
      if (Number.isFinite(timestamp) && Date.now() - timestamp > staleMs) await rm(path, { recursive: true, force: true });
    } catch {
      const details = await stat(path).catch(() => null);
      if (details && Date.now() - details.mtimeMs > staleMs) await rm(path, { recursive: true, force: true });
    }
  }
}

function probeSocket(path) {
  return new Promise((resolveProbe) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(alive);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => socket.write(`${JSON.stringify({ action: "probe" })}\n`));
    socket.on("data", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function runWatchdog() {
  if (!childStartedAt || state === "terminating") return;
  const now = Date.now();
  const sampled = sampleActivity();
  const progressed = sampled.runningContainers > 0 || !previousActivity
    || sampled.cpuTicks > previousActivity.cpuTicks || sampled.ioBytes > previousActivity.ioBytes;
  activity = sampled;
  previousActivity = sampled;
  if (progressed) {
    lastActivityAt = now;
    if (state === "stalled") state = "running";
    warned = false;
  }
  const idleFor = now - lastActivityAt;
  if (!warned && idleFor >= inactivityWarnMs) {
    warned = true;
    state = "stalled";
    lifecycle("INACTIVITY_WARNING", `run=${runId} progress_idle=${formatElapsed(idleFor)} output_silent=${formatElapsed(now - lastOutputAt)} timeout=${formatElapsed(inactivityTimeoutMs)}`);
    void updateOwner();
  }
  if (idleFor >= inactivityTimeoutMs) requestTermination(`no observed process, I/O, output, or running-container progress for ${formatElapsed(idleFor)}`, 124);
  else if (now - childStartedAt >= runtimeTimeoutMs) requestTermination(`runtime exceeded ${formatElapsed(runtimeTimeoutMs)}`, 124);
}

function requestTermination(reason, exitCode) {
  if (!child || state === "terminating") return;
  state = "terminating";
  terminationReason = reason;
  desiredExitCode = exitCode;
  lifecycle("TERMINATING", `run=${runId} reason=${reason} grace=${formatElapsed(terminationGraceMs)}`);
  signalProcessGroup("SIGTERM");
  void updateOwner();
  forceTimer = setTimeout(() => {
    forced = true;
    lifecycle("FORCE_KILLING", `run=${runId} processGroup=${child.pid}`);
    signalProcessGroup("SIGKILL");
    void cleanupDockerContainers();
  }, terminationGraceMs);
}

function signalProcessGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* child already exited */ }
  }
}

function relayChildOutput(destination, chunk) {
  lastOutputAt = Date.now();
  lastActivityAt = lastOutputAt;
  if (state === "stalled") state = "running";
  warned = false;
  destination.write(chunk);
  writeLog(chunk);
}

function updateOwner() {
  ownerWrite = ownerWrite.then(writeOwner);
  return ownerWrite;
}

async function writeOwner() {
  const owner = {
    version: 3,
    runId,
    workspaceId,
    state,
    command,
    commandDisplay: formatCommand(command),
    cwd: process.cwd(),
    wrapperPid: process.pid,
    childPid: child?.pid ?? null,
    slot,
    controlSocket,
    logPath: log?.path ?? null,
    queuedAt: new Date(startedWaitingAt).toISOString(),
    startedAt: childStartedAt ? new Date(childStartedAt).toISOString() : null,
    lastOutputAt: lastOutputAt ? new Date(lastOutputAt).toISOString() : null,
    lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
    activity,
    heartbeatAt: new Date().toISOString(),
    deadlines: {
      inactivityWarnMs,
      inactivityTimeoutMs,
      runtimeTimeoutMs,
      terminationGraceMs
    },
    packageDiagnostics,
    terminationReason,
    exitCode: state === "completed" ? process.exitCode ?? null : null
  };
  const temporary = join(runDir, `owner-${process.pid}-${randomBytes(3).toString("hex")}.tmp`);
  await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
  await rename(temporary, join(runDir, "owner.json"));
}

async function createRunLog() {
  const statusFile = process.env.MUXPILOT_GIT_STATUS_FILE;
  const root = statusFile ? join(dirname(statusFile), "heavy-commands") : join(runDir, "logs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await pruneLogs(root);
  const path = join(root, `${new Date().toISOString().replaceAll(":", "-")}-${runId}.log`);
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const value = { root, path, stream, bytes: 0, truncated: false, maxBytes: 50 * 1024 * 1024 };
  await new Promise((resolveOpen, reject) => { stream.once("open", resolveOpen); stream.once("error", reject); });
  return value;
}

function writeLog(chunk) {
  if (!log || log.truncated) return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = log.maxBytes - log.bytes;
  const marker = Buffer.from("\n[MUXPILOT_LOG_TRUNCATED at 50 MiB]\n");
  if (remaining > 0) {
    const limit = buffer.length > remaining ? Math.max(0, remaining - marker.length) : remaining;
    const slice = buffer.subarray(0, limit);
    log.stream.write(slice);
    log.bytes += slice.length;
  }
  if (buffer.length > remaining) {
    log.truncated = true;
    const markerSlice = marker.subarray(0, Math.max(0, log.maxBytes - log.bytes));
    log.stream.write(markerSlice);
    log.bytes += markerSlice.length;
  }
}

function lifecycle(event, details = "") {
  const message = `[muxpilot-heavy] ${new Date().toISOString()} ${event}${details ? ` ${details}` : ""}\n`;
  process.stderr.write(message);
  writeLog(message);
}

async function finalizeRun() {
  state = "completed";
  try { await updateOwner(); } catch { /* best effort final metadata */ }
  if (log) {
    await new Promise((resolveEnd) => log.stream.end(resolveEnd));
    const summaryPath = `${log.path}.json`;
    await writeFile(summaryPath, JSON.stringify({ runId, workspaceId, command, state, terminationReason, forced, exitCode: process.exitCode, finishedAt: new Date().toISOString() }), { mode: 0o600 });
    await pruneLogs(log.root);
  }
}

async function pruneLogs(root) {
  const entries = await readdir(root).catch(() => []);
  const logs = [];
  for (const entry of entries.filter((name) => name.endsWith(".log"))) {
    const details = await stat(join(root, entry)).catch(() => null);
    if (details) logs.push({ entry, mtimeMs: details.mtimeMs });
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const old of logs.slice(20)) {
    await rm(join(root, old.entry), { force: true });
    await rm(join(root, `${old.entry}.json`), { force: true });
  }
}

function inspectPackageManager() {
  const result = { declared: null, resolvedPath: null, resolvedVersion: null, storePath: null, cachePaths: {}, warnings: [], messages: [] };
  let cursor = resolve(process.cwd());
  while (true) {
    const packagePath = join(cursor, "package.json");
    if (existsSync(packagePath)) {
      try { result.declared = JSON.parse(readFileSync(packagePath, "utf8")).packageManager ?? null; } catch { /* diagnostic only */ }
      if (result.declared) break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (basename(command[0]) === "pnpm" || result.declared?.startsWith("pnpm@")) {
    const pnpmExecutable = basename(command[0]) === "pnpm" ? resolveExecutable(command[0]) : resolveExecutable("pnpm");
    result.resolvedPath = pnpmExecutable;
    const version = spawnSync(pnpmExecutable ?? "pnpm", ["--version"], { encoding: "utf8", timeout: 5_000, env: process.env });
    result.resolvedVersion = version.status === 0 ? version.stdout.trim() : null;
    const store = spawnSync(pnpmExecutable ?? "pnpm", ["store", "path"], { encoding: "utf8", timeout: 5_000, env: process.env });
    result.storePath = store.status === 0 ? store.stdout.trim() : null;
    const expected = result.declared?.split("@").at(-1);
    if (expected && result.resolvedVersion && expected !== result.resolvedVersion) result.warnings.push(`declared pnpm ${expected}, resolved ${result.resolvedVersion}`);
    if (!result.storePath) result.warnings.push("unable to resolve pnpm store path");
  }
  for (const name of ["XDG_CACHE_HOME", "PNPM_HOME", "npm_config_cache"]) {
    if (process.env[name]) result.cachePaths[name] = { path: process.env[name], writable: pathWritable(process.env[name]) };
  }
  result.messages.push({ level: "PACKAGE_DIAGNOSTICS", text: `declared=${result.declared ?? "none"} executable=${result.resolvedPath ?? "unresolved"} version=${result.resolvedVersion ?? "unknown"} store=${result.storePath ?? "unknown"}` });
  for (const warning of result.warnings) result.messages.push({ level: "PACKAGE_WARNING", text: warning });
  return result;
}

function resolveExecutable(name) {
  if (name.includes("/")) return existsSync(resolve(name)) ? resolve(name) : null;
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  return null;
}

function pathWritable(path) {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

async function pruneRunRecords() {
  const runsRoot = join(leaseRoot, "runs");
  const completed = [];
  for (const entry of await readdir(runsRoot).catch(() => [])) {
    if (entry === runId) continue;
    try {
      const owner = JSON.parse(await readFile(join(runsRoot, entry, "owner.json"), "utf8"));
      if (owner.workspaceId === workspaceId && owner.state === "completed") {
        completed.push({ entry, finishedAt: Date.parse(owner.heartbeatAt) || 0 });
      }
    } catch { /* malformed and legacy records are left for stale cleanup */ }
  }
  completed.sort((left, right) => right.finishedAt - left.finishedAt);
  for (const old of completed.slice(19)) {
    if (!hasDockerContainers(old.entry)) await rm(join(runsRoot, old.entry), { recursive: true, force: true });
  }
}

function hasDockerContainers(candidateRunId) {
  if (!resolveExecutable("docker")) return false;
  const result = spawnSync("docker", ["ps", "-aq", "--filter", `label=com.muxpilot.heavy-run=${candidateRunId}`], { encoding: "utf8", timeout: 2_000, env: process.env });
  return result.status !== 0 || Boolean(result.stdout.trim());
}

async function cleanupDockerContainers() {
  if (!resolveExecutable("docker")) return;
  const deadline = Date.now() + 30_000;
  let emptySamples = 0;
  let emptySince = null;
  let observedContainers = false;
  let lastDetail = "";
  while (Date.now() < deadline) {
    const list = listRunContainers(5_000);
    if (list.status !== 0) {
      emptySamples = 0;
      emptySince = null;
      lastDetail = commandDetail(list.stderr, "docker ps failed");
      lifecycle("DOCKER_CLEANUP_RETRY", `run=${runId} reason=list detail=${lastDetail}`);
    } else if (list.ids.length === 0) {
      emptySince ??= Date.now();
      emptySamples += 1;
      if (emptySamples >= 3 && Date.now() - emptySince >= 1_000) {
        if (observedContainers) lifecycle("DOCKER_CLEANUP_COMPLETE", `run=${runId} containers=0`);
        return;
      }
    } else {
      emptySamples = 0;
      emptySince = null;
      observedContainers = true;
      lifecycle("DOCKER_CLEANUP", `run=${runId} containers=${list.ids.length}`);
      const removed = spawnSync("docker", ["rm", "--force", ...list.ids], { encoding: "utf8", timeout: 10_000, env: process.env });
      if (removed.status !== 0) {
        lastDetail = commandDetail(removed.stderr, "docker rm failed");
        lifecycle("DOCKER_CLEANUP_RETRY", `run=${runId} reason=remove containers=${list.ids.length} detail=${lastDetail}`);
      }
    }
    await delay(250);
  }
  const remaining = listRunContainers(5_000);
  lifecycle("DOCKER_CLEANUP_FAILED", `run=${runId} containers=${remaining.ids.length} detail=${remaining.status === 0 ? lastDetail || "cleanup deadline exceeded" : commandDetail(remaining.stderr, "docker ps failed")}`);
}

function listRunContainers(timeout) {
  const result = spawnSync("docker", ["ps", "-aq", "--filter", `label=com.muxpilot.heavy-run=${runId}`], { encoding: "utf8", timeout, env: process.env });
  return {
    status: result.status,
    stderr: result.stderr,
    ids: result.status === 0 ? result.stdout.trim().split(/\s+/).filter(Boolean) : []
  };
}

function diagnoseResourceExit() {
  const list = listRunContainers(5_000);
  let cause = "probable-oom-or-external-sigkill";
  if (list.status === 0 && list.ids.length > 0) {
    const inspected = spawnSync("docker", ["inspect", "--format", "{{json .State}}", ...list.ids], { encoding: "utf8", timeout: 5_000, env: process.env });
    if (inspected.status === 0 && inspected.stdout.split(/\r?\n/).some((line) => {
      try { return JSON.parse(line).OOMKilled === true; } catch { return false; }
    })) cause = "docker-oom";
  }
  lifecycle("RESOURCE_LIMIT_WARNING", `run=${runId} cause=${cause} code=${childOutcome?.code ?? "null"} signal=${childOutcome?.signal ?? "none"} guidance=${JSON.stringify("split the command targets or review configured resource limits; muxpilot will not retry automatically")}`);
}

async function prepareJsiiCache() {
  const configured = process.env.JSII_RUNTIME_PACKAGE_CACHE_ROOT;
  if (configured && await ensureWritableDirectory(configured)) return { path: configured, fallback: false, reason: "configured" };
  const workspace = String(workspaceId ?? "shared").replace(/[^A-Za-z0-9_.-]/g, "_");
  const fallback = join(leaseRoot, "caches", "jsii", workspace);
  await mkdir(fallback, { recursive: true, mode: 0o700 });
  await chmod(fallback, 0o700);
  return { path: fallback, fallback: true, reason: configured ? "configured-path-unwritable" : "unset" };
}

async function ensureWritableDirectory(path) {
  const probe = join(path, `.muxpilot-write-probe-${runId}`);
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    accessSync(path, constants.W_OK);
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }
}

function commandDetail(value, fallback) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 500) || fallback;
}

function sampleActivity() {
  let processCount = 0;
  let cpuTicks = 0;
  let ioBytes = 0;
  if (child?.pid && process.platform === "linux") {
    for (const entry of readdirSync("/proc").filter((value) => /^\d+$/.test(value))) {
      try {
        const statText = readFileSync(`/proc/${entry}/stat`, "utf8");
        const tail = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
        if (Number(tail[2]) !== child.pid) continue;
        processCount += 1;
        cpuTicks += Number(tail[11]) + Number(tail[12]);
        const io = readFileSync(`/proc/${entry}/io`, "utf8");
        ioBytes += Number(io.match(/^read_bytes:\s+(\d+)/m)?.[1] ?? 0) + Number(io.match(/^write_bytes:\s+(\d+)/m)?.[1] ?? 0);
      } catch { /* process exited during sampling or proc entry is restricted */ }
    }
  }
  if (Date.now() - lastDockerSampleAt >= 5_000 && resolveExecutable("docker")) {
    lastDockerSampleAt = Date.now();
    const result = spawnSync("docker", ["ps", "-a", "--filter", `label=com.muxpilot.heavy-run=${runId}`, "--format", "{{.State}}"], { encoding: "utf8", timeout: 1_000, env: process.env });
    if (result.status === 0) {
      dockerActivity = { runningContainers: 0, createdContainers: 0 };
      for (const value of result.stdout.trim().split(/\s+/).filter(Boolean)) {
        if (value === "running" || value === "restarting") dockerActivity.runningContainers += 1;
        if (value === "created") dockerActivity.createdContainers += 1;
      }
    }
  }
  return { processCount, cpuTicks, ioBytes, ...dockerActivity };
}

function appendDockerHeader(existing, name, value) {
  if (!value) return existing;
  return [existing, `${name}=${value}`].filter(Boolean).join(",");
}

function validSocketPath(path) {
  if (typeof path !== "string") return false;
  const runsRoot = resolve(leaseRoot, "runs");
  const socketPath = resolve(path);
  return socketPath.startsWith(`${runsRoot}${process.platform === "win32" ? "\\" : "/"}`) && basename(socketPath) === "control.sock";
}

function clearRuntimeTimers() {
  for (const timer of [heartbeatTimer, consoleTimer, watchdogTimer, forceTimer]) if (timer) clearInterval(timer);
}

function duration(flagValue, environmentValue, fallback) {
  const raw = flagValue ?? environmentValue;
  if (raw === undefined) return fallback;
  const match = String(raw).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) fail(`invalid duration: ${raw}`);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? "ms").toLowerCase()];
  const value = Math.round(Number(match[1]) * multiplier);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`invalid duration: ${raw}`);
  return value;
}

function positiveInteger(value, fallback) {
  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function formatElapsed(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatCommand(parts) {
  return parts.map((part) => /^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
}

function delay(milliseconds) { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }

function fail(message) { console.error(message); process.exit(2); }
