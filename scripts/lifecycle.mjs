import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync
} from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncMuxpilotGitWorkflowSkill } from "./bundled-skill.mjs";

const HEALTH_CHECK_TIMEOUT_MS = 5000;
const DEFAULT_START_TIMEOUT_MS = 30000;
const PRODUCTION_START_TIMEOUT_MS = 5 * 60 * 1000;
const START_PROGRESS_INTERVAL_MS = 10 * 1000;
const START_POLL_MS = 500;
const STOP_GRACE_MS = 1500;
const DEFAULT_DEV_PORTS = ["4177", "5177"];
const DEFAULT_PROD_PORTS = ["12777", "12778"];
const DEFAULT_SHADOW_PORTS = ["14177", "15177"];
const MODES = ["dev", "prod", "shadow"];
const PROCESSES = ["supervisor", "server", "web"];
const DEFAULT_RUNTIME_LOG_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RUNTIME_LOG_RETAINED_FILES = 3;
const APP_SERVER_CAPABILITY_ID = /^[a-f0-9]{24}$/;
const HEAVY_RESOURCE_UNIT = /^muxpilot-heavy-[a-z0-9]+-[a-f0-9]{12}-[a-f0-9]{6}\.service$/;
const RUNTIME_ENV_KEYS = [
  "MUXPILOT_SHADOW",
  "MUXPILOT_SHADOW_RESOURCE_GOVERNOR",
  "MUXPILOT_SHADOW_RUNTIME_PATH",
  "MUXPILOT_LAN_ENABLED",
  "MUXPILOT_HOST",
  "MUXPILOT_PORT",
  "MUXPILOT_API_TARGET",
  "MUXPILOT_WEB_PROTOCOL",
  "MUXPILOT_WEB_PORT",
  "MUXPILOT_HTTPS_CERT",
  "MUXPILOT_HTTPS_KEY",
  "MUXPILOT_PWA_TRUST_PORT",
  "MUXPILOT_PWA_TRUST_DIR",
  "MUXPILOT_CORS_ORIGINS",
  "MUXPILOT_DATA_DIR",
  "MUXPILOT_DB_PATH",
  "MUXPILOT_SKILL_HOME",
  "MUXPILOT_GIT_WORKTREE_ROOT",
  "MUXPILOT_GIT_SESSION_ROOT",
  "MUXPILOT_RESOURCE_GOVERNOR",
  "MUXPILOT_AGENT_MEMORY_SOFT_PERCENT",
  "MUXPILOT_AGENT_MEMORY_HARD_PERCENT",
  "MUXPILOT_AGENT_CPU_PERCENT",
  "MUXPILOT_DOCKER_MEMORY_SOFT_PERCENT",
  "MUXPILOT_DOCKER_MEMORY_HARD_PERCENT",
  "MUXPILOT_DOCKER_CPU_PERCENT",
  "MUXPILOT_SESSION_TASKS_MAX",
  "MUXPILOT_HEAVY_VALIDATION_CONCURRENCY",
  "MUXPILOT_HEAVY_VALIDATION_DIR",
  "MUXPILOT_HEAVY_VALIDATION_INACTIVITY_WARN_MS",
  "MUXPILOT_HEAVY_VALIDATION_INACTIVITY_TIMEOUT_MS",
  "MUXPILOT_HEAVY_VALIDATION_RUNTIME_TIMEOUT_MS",
  "MUXPILOT_HEAVY_VALIDATION_TERMINATION_GRACE_MS",
  "MUXPILOT_HEAVY_VALIDATION_RESUME_TIMEOUT_MS",
  "VITE_MUXPILOT_SHADOW",
  "PATH"
];

const MODE_CONFIG = {
  dev: {
    label: "development",
    backendPort: "4177",
    webPort: "5177",
    dataDir: "./data/dev",
    dbPath: "./data/dev/muxpilot.db",
    build: false,
    backendArgs: ["--filter", "@muxpilot/server", "dev"],
    webArgs: ["--filter", "@muxpilot/web", "dev"]
  },
  prod: {
    label: "production",
    backendPort: "12777",
    webPort: "12778",
    dataDir: "./data/prod",
    dbPath: "./data/prod/muxpilot.db",
    build: "workspace",
    backendArgs: ["--filter", "@muxpilot/server", "start"],
    webArgs: ["--filter", "@muxpilot/web", "start"]
  },
  shadow: {
    label: "shadow",
    backendPort: "14177",
    webPort: "15177",
    dataDir: "./data/shadow",
    dbPath: "./data/shadow/muxpilot.db",
    build: "core",
    backendArgs: ["--filter", "@muxpilot/server", "dev"],
    webArgs: ["--filter", "@muxpilot/web", "dev"]
  }
};

export async function startMode(mode) {
  const details = prepareMode(mode);
  const { config, state, urls } = details;

  try {
    await syncBundledSkillForMode(mode);
    cleanupStalePidFiles(state);

    const status = await inspectPreparedMode(details);
    if (status.backendActive && status.webActive) {
      console.log(`${capitalize(config.label)} is already active at ${urls.webUrl}.`);
      if (!status.supervisorRunning) {
        console.log(`It is not currently supervisor-managed. Run "pnpm app restart ${mode}" to move it under the supervisor.`);
      }
      printState(state);
      return;
    }

    if (status.supervisorRunning) {
      console.error(`${capitalize(config.label)} supervisor is running, but the app is not healthy yet.`);
      console.error(`Run "pnpm app status ${mode}" or "pnpm app logs ${mode} --process all" for details.`);
      process.exit(1);
    }

    if (status.backendPortOccupied || status.webPortOccupied) {
      if (status.backendPortOccupied && !status.backendActive) {
        console.error(`Backend port ${urls.backendPort} is already in use, but ${urls.backendUrl}/healthz did not respond.`);
      }
      if (status.webPortOccupied && !status.webActive) {
        console.error(`Frontend port ${urls.webPort} is already in use, but ${urls.webUrl} did not respond.`);
      }
      console.error(`Not starting duplicate processes. Run "pnpm app status ${mode}" and stop the conflicting process first.`);
      process.exit(1);
    }

    if (mode === "shadow") assertShadowDependencyIsolation(process.cwd());
    if (config.build === "workspace") runPnpmSync(["build"]);
    if (config.build === "core") runPnpmSync(["--filter", "@muxpilot/core", "build"]);

    const timeoutMs = startupTimeoutMs(mode);
    spawnSupervisor(mode, state);
    console.log(`Starting ${config.label} under the muxpilot supervisor...`);

    const ready = await waitForEndpoints([
      { name: "backend", url: `${urls.backendUrl}/healthz` },
      { name: "frontend", url: urls.webUrl }
    ], timeoutMs, ({ elapsedMs, endpoints }) => {
      console.log(formatStartupWaitProgress(config.label, elapsedMs, endpoints));
    });

    if (!ready.ok) {
      console.error(`Timed out after ${formatWaitDuration(ready.elapsedMs)} waiting for ${ready.name} at ${ready.url}.`);
      printState(state);
      process.exit(1);
    }

    console.log(`${capitalize(config.label)} is ready at ${urls.webUrl} with backend ${urls.backendUrl}.`);
    printState(state);
  } finally {
    restoreEnv(details.envSnapshot);
  }
}

export async function syncBundledSkillForMode(mode, codexHome = process.env.MUXPILOT_CODEX_HOME ?? join(homedir(), ".codex")) {
  if (mode !== "prod") return null;
  try {
    const result = await syncMuxpilotGitWorkflowSkill(codexHome);
    const verb = result.action === "unchanged" ? "is current" : `${result.action}`;
    console.log(`Muxpilot bundled skills ${verb}; workflow path ${result.path}.`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not synchronize muxpilot bundled skills: ${message}`, { cause: error });
  }
}

export async function stopMode(mode) {
  assertModeOrAll(mode, "stop");
  loadDotenv();

  const modes = mode === "all" ? MODES : [mode];
  const pidCandidates = new Map();

  for (const targetMode of modes) {
    for (const candidate of readStatePids(targetMode)) {
      pidCandidates.set(candidate.pid, candidate);
    }
  }

  const ports = mode === "all" ? allLocalPorts() : modePorts(mode);
  for (const port of ports) {
    for (const pid of findListeningPids(port)) {
      pidCandidates.set(pid, { pid, source: `port ${port}` });
    }
  }

  const allPids = [...pidCandidates.keys()].filter((pid) => pid !== process.pid && isRunning(pid));
  if (allPids.length === 0) {
    console.log(`No ${modeLabel(mode)} servers found on ports ${ports.join(", ")}.`);
    removePidFiles(modes);
  } else {
    const supervisorPids = allPids.filter((pid) => pidCandidates.get(pid)?.role === "supervisor");
    const otherPids = allPids.filter((pid) => !supervisorPids.includes(pid));

    for (const pid of supervisorPids) {
      console.log(`Stopping supervisor PID ${pid} (${pidCandidates.get(pid)?.source ?? "runtime state"})`);
      terminatePid(pid, "SIGTERM");
    }
    await sleep(STOP_GRACE_MS);

    for (const pid of otherPids) {
      if (!isRunning(pid)) continue;
      console.log(`Stopping PID ${pid} (${pidCandidates.get(pid)?.source ?? "runtime state"})`);
      terminatePid(pid, "SIGTERM");
    }
    await sleep(STOP_GRACE_MS);

    for (const pid of allPids.filter(isRunning)) {
      console.log(`Force-stopping PID ${pid}`);
      terminatePid(pid, "SIGKILL");
    }
  }

  removePidFiles(modes);
  if (modes.includes("shadow")) stopShadowSystemdUnits(resolve(MODE_CONFIG.shadow.dataDir));
  console.log(`${capitalize(modeLabel(mode))} server stop complete.`);
}

export async function restartMode(mode) {
  assertModeOrAll(mode, "restart");

  if (mode === "all") {
    const modes = runningModes("all");
    if (modes.length === 0) {
      console.log("No active local servers found. Leaving development and production down.");
      return;
    }
    console.log(`Restarting active environments: ${modes.join(", ")}.`);
    for (const runningMode of modes) await stopMode(runningMode);
    for (const runningMode of modes) await startMode(runningMode);
    return;
  }

  await stopMode(mode);
  await startMode(mode);
}

export function runningModes(mode = "all") {
  assertModeOrAll(mode, "status");
  loadDotenv();

  const modes = mode === "all" ? MODES : [mode];
  return modes.filter(modeHasRunningServers);
}

export async function statusMode(mode = "all") {
  assertModeOrAll(mode, "status");
  const modes = mode === "all" ? MODES : [mode];

  for (const [index, targetMode] of modes.entries()) {
    const details = prepareMode(targetMode);
    try {
      cleanupStalePidFiles(details.state);
      const status = await inspectPreparedMode(details);
      if (index > 0) console.log("");
      printStatus(targetMode, details, status);
    } finally {
      restoreEnv(details.envSnapshot);
    }
  }
}

export async function logsMode(mode, options = {}) {
  assertMode(mode, "logs");
  const state = runtimeState(mode);
  const requestedProcesses = normalizeLogProcesses(options.processes ?? ["server"]);
  const files = requestedProcesses.map((processName) => ({
    processName,
    path: state[`${processName}LogPath`]
  }));
  const lines = normalizeLineCount(options.lines ?? 80);

  for (const [index, file] of files.entries()) {
    if (files.length > 1 || index > 0) {
      console.log(`${index > 0 ? "\n" : ""}==> ${file.processName}: ${file.path} <==`);
    }
    process.stdout.write(readLastLines(file.path, lines));
  }

  if (!options.follow) return;

  console.log(files.length > 1 ? "\nFollowing logs. Press Ctrl+C to stop." : "\nFollowing log. Press Ctrl+C to stop.");
  const offsets = new Map(files.map((file) => [file.path, fileSize(file.path)]));

  for (const file of files) {
    watchFile(file.path, { interval: 500 }, () => {
      const previous = offsets.get(file.path) ?? 0;
      const next = fileSize(file.path);
      if (next < previous) offsets.set(file.path, 0);
      const start = Math.min(previous, next);
      const chunk = readRange(file.path, start, next);
      offsets.set(file.path, next);
      if (!chunk) return;
      if (files.length > 1) process.stdout.write(`\n==> ${file.processName}: ${file.path} <==\n`);
      process.stdout.write(chunk);
    });
  }

  await new Promise((resolveFollow) => {
    const stop = () => {
      for (const file of files) unwatchFile(file.path);
      resolveFollow(undefined);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function supervisorConfig(mode) {
  const details = prepareMode(mode);
  return details;
}

export function writePid(path, pid = process.pid) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`);
}

export function appendSupervisorLog(state, message) {
  appendFileSync(state.supervisorLogPath, `${new Date().toISOString()} ${message}\n`);
}

export function spawnService(name, args, state) {
  const logPath = name === "server" ? state.serverLogPath : state.webLogPath;
  const pidPath = name === "server" ? state.serverPidPath : state.webPidPath;
  rotateRuntimeLog(logPath);
  appendFileSync(logPath, `\n--- ${new Date().toISOString()} starting ${name}: pnpm ${args.join(" ")} ---\n`);
  const logFd = openSync(logPath, "a");

  try {
    const child = spawn("pnpm", args, {
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd]
    });
    writePid(pidPath, child.pid);
    return child;
  } finally {
    closeSync(logFd);
  }
}

export function runtimeLogPolicy(env = process.env) {
  return {
    maxBytes: positiveInteger(env.MUXPILOT_RUNTIME_LOG_MAX_BYTES, DEFAULT_RUNTIME_LOG_MAX_BYTES),
    retainedFiles: positiveInteger(env.MUXPILOT_RUNTIME_LOG_RETAINED_FILES, DEFAULT_RUNTIME_LOG_RETAINED_FILES)
  };
}

export function rotateRuntimeLog(logPath, env = process.env) {
  const { maxBytes, retainedFiles } = runtimeLogPolicy(env);
  if (!existsSync(logPath) || statSync(logPath).size < maxBytes) return false;

  rmSync(`${logPath}.${retainedFiles}`, { force: true });
  for (let index = retainedFiles - 1; index >= 1; index -= 1) {
    const source = `${logPath}.${index}`;
    if (existsSync(source)) renameSync(source, `${logPath}.${index + 1}`);
  }
  renameSync(logPath, `${logPath}.1`);
  return true;
}

export function runtimeState(mode) {
  const dir = resolve("data", "runtime", mode);
  return {
    dir,
    supervisorPidPath: join(dir, "supervisor.pid"),
    serverPidPath: join(dir, "server.pid"),
    webPidPath: join(dir, "web.pid"),
    supervisorLogPath: join(dir, "supervisor.log"),
    serverLogPath: join(dir, "server.log"),
    webLogPath: join(dir, "web.log")
  };
}

function prepareMode(mode) {
  const config = modeConfig(mode);
  const envSnapshot = snapshotEnv(RUNTIME_ENV_KEYS);

  loadDotenv();
  if (mode === "shadow") applyShadowIsolation(config);
  else applyRuntimeDefaults(config);

  const state = runtimeState(mode);
  mkdirSync(state.dir, { recursive: true });

  const backendPort = validPort(process.env.MUXPILOT_PORT, Number(config.backendPort));
  const webPort = validPort(process.env.MUXPILOT_WEB_PORT, Number(config.webPort));
  const webProtocol = process.env.MUXPILOT_WEB_PROTOCOL ?? "http";
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const webUrl = `${webProtocol}://127.0.0.1:${webPort}`;

  return {
    mode,
    config,
    state,
    envSnapshot,
    urls: { backendPort, webPort, backendUrl, webUrl }
  };
}

async function inspectPreparedMode(details) {
  const { state, urls } = details;
  const [backendHealth, webActive, backendPortOccupied, webPortOccupied] = await Promise.all([
    readJsonEndpoint(`${urls.backendUrl}/healthz`),
    endpointActive(urls.webUrl),
    portOccupied("127.0.0.1", urls.backendPort),
    portOccupied("127.0.0.1", urls.webPort)
  ]);
  const pids = readStatePids(details.mode, { includeStale: true });

  return {
    backendActive: Boolean(backendHealth),
    backendHealth,
    webActive,
    backendPortOccupied,
    webPortOccupied,
    supervisorRunning: pids.some((candidate) => candidate.role === "supervisor" && candidate.running),
    pids
  };
}

function printStatus(mode, details, status) {
  const { config, state, urls } = details;
  const stalePids = status.pids.filter((candidate) => !candidate.running);
  const runningPids = status.pids.filter((candidate) => candidate.running);
  const portConflicts = [
    status.backendPortOccupied && !status.backendActive ? `backend ${urls.backendPort}` : null,
    status.webPortOccupied && !status.webActive ? `frontend ${urls.webPort}` : null
  ].filter(Boolean);

  let stateLabel = "stopped";
  if (status.supervisorRunning && status.backendActive && status.webActive) stateLabel = "running";
  else if (status.backendActive && status.webActive) stateLabel = "unmanaged";
  else if (status.supervisorRunning) stateLabel = "unhealthy";
  else if (status.backendActive || status.webActive || runningPids.length > 0) stateLabel = "partial";
  else if (portConflicts.length > 0) stateLabel = "port-conflict";
  else if (stalePids.length > 0) stateLabel = "stale-pid";

  console.log(`${mode}: ${stateLabel} (${config.label})`);
  console.log(`  web: ${urls.webUrl} ${status.webActive ? "healthy" : "not healthy"}`);
  console.log(`  backend: ${urls.backendUrl} ${status.backendActive ? "healthy" : "not healthy"}`);
  console.log(`  runtime: ${state.dir}`);
  const appServerCompatibility = status.backendHealth?.appServerCompatibility;
  if (appServerCompatibility) console.log(`  app-server: ${appServerCompatibility.available ? "available" : appServerCompatibility.status}`);
  if (mode === "shadow") {
    console.log(`  isolation: active (loopback-only; new shadow sessions only)`);
    console.log(`  data: ${process.env.MUXPILOT_DATA_DIR}`);
  }
  const governor = process.env.MUXPILOT_RESOURCE_GOVERNOR ?? "auto";
  const dockerGuardSocket = resolve(process.env.MUXPILOT_DATA_DIR ?? config.dataDir, "runtime", "docker-guard.sock");
  console.log(`  resource governor: ${governor}`);
  if (governor !== "off") {
    const dockerGuardActive = status.backendHealth
      ? status.backendHealth.dockerGuardActive === true
      : existsSync(dockerGuardSocket);
    console.log(`    agents: memory ${process.env.MUXPILOT_AGENT_MEMORY_SOFT_PERCENT ?? "50"}% soft / ${process.env.MUXPILOT_AGENT_MEMORY_HARD_PERCENT ?? "60"}% hard, cpu ${process.env.MUXPILOT_AGENT_CPU_PERCENT ?? "75"}%, tasks ${process.env.MUXPILOT_SESSION_TASKS_MAX ?? "768"}`);
    console.log(`    docker: memory ${process.env.MUXPILOT_DOCKER_MEMORY_SOFT_PERCENT ?? "15"}% soft / ${process.env.MUXPILOT_DOCKER_MEMORY_HARD_PERCENT ?? "20"}% hard, cpu ${process.env.MUXPILOT_DOCKER_CPU_PERCENT ?? "25"}%, proxy ${dockerGuardActive ? "active" : "inactive"}`);
    console.log(`    heavyweight validation concurrency: ${process.env.MUXPILOT_HEAVY_VALIDATION_CONCURRENCY ?? "2"}`);
    console.log(`    heavyweight timeouts: warn ${process.env.MUXPILOT_HEAVY_VALIDATION_INACTIVITY_WARN_MS ?? "60000"}ms, silent ${process.env.MUXPILOT_HEAVY_VALIDATION_INACTIVITY_TIMEOUT_MS ?? "600000"}ms, runtime ${process.env.MUXPILOT_HEAVY_VALIDATION_RUNTIME_TIMEOUT_MS ?? "1800000"}ms, termination grace ${process.env.MUXPILOT_HEAVY_VALIDATION_TERMINATION_GRACE_MS ?? "30000"}ms`);
    console.log(`    heavyweight resume timeout: ${process.env.MUXPILOT_HEAVY_VALIDATION_RESUME_TIMEOUT_MS ?? "120000"}ms`);
    const live = status.backendHealth?.resourceGovernor;
    if (live) {
      for (const line of resourceGovernorSessionScopeLines(live)) console.log(`    ${line}`);
      console.log(`    scoped sessions: ${live.busySessions} busy, ${live.idleSessions} idle`);
      if (live.busyMemoryHighBytes !== null) {
        console.log(`    current busy-session share: ${formatBytes(live.busyMemoryHighBytes)} soft / ${formatBytes(live.busyMemoryMaxBytes)} hard, cpu ${live.busyCpuPercent}%`);
      }
    }
  }
  console.log(`  logs:`);
  console.log(`    supervisor: ${state.supervisorLogPath}`);
  console.log(`    server: ${state.serverLogPath}`);
  console.log(`    web: ${state.webLogPath}`);
  console.log(`  pids:`);
  for (const role of PROCESSES) {
    const candidate = status.pids.find((pid) => pid.role === role);
    const value = candidate ? `${candidate.pid} ${candidate.running ? "running" : "stale"}` : "none";
    console.log(`    ${role}: ${value}`);
  }
  if (portConflicts.length > 0) console.log(`  port conflicts: ${portConflicts.join(", ")}`);
}

function spawnSupervisor(mode, state) {
  const supervisorPath = fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
  rotateRuntimeLog(state.supervisorLogPath);
  appendFileSync(state.supervisorLogPath, `\n--- ${new Date().toISOString()} starting supervisor: node ${supervisorPath} ${mode} ---\n`);
  const logFd = openSync(state.supervisorLogPath, "a");

  try {
    const child = spawn(process.execPath, [supervisorPath, mode], {
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd]
    });
    child.on("error", (error) => {
      console.error(`Could not start supervisor: ${error.message}`);
      process.exit(1);
    });
    child.unref();
    writePid(state.supervisorPidPath, child.pid);
  } finally {
    closeSync(logFd);
  }
}

function positiveInteger(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function modeConfig(mode) {
  const config = MODE_CONFIG[mode];
  if (!config) {
    console.error(`Usage: pnpm app <start|stop|restart|status|logs> [${MODES.join("|")}|all]`);
    process.exit(1);
  }
  return config;
}

function modeHasRunningServers(mode) {
  for (const candidate of readStatePids(mode)) {
    if (candidate.pid !== process.pid && isRunning(candidate.pid)) return true;
  }

  for (const port of modePorts(mode)) {
    const pids = findListeningPids(port).filter((pid) => pid !== process.pid && isRunning(pid));
    if (pids.length > 0) return true;
  }

  return false;
}

function readStatePids(mode, options = {}) {
  const state = runtimeState(mode);
  return [
    { role: "supervisor", pid: readPid(state.supervisorPidPath), source: `${mode} supervisor pid file` },
    { role: "server", pid: readPid(state.serverPidPath), source: `${mode} server pid file` },
    { role: "web", pid: readPid(state.webPidPath), source: `${mode} web pid file` }
  ]
    .filter((candidate) => candidate.pid)
    .map((candidate) => ({ ...candidate, running: isRunning(candidate.pid) }))
    .filter((candidate) => options.includeStale || candidate.running);
}

function readPid(path) {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removePidFiles(modes) {
  for (const mode of modes) {
    const state = runtimeState(mode);
    rmSync(state.supervisorPidPath, { force: true });
    rmSync(state.serverPidPath, { force: true });
    rmSync(state.webPidPath, { force: true });
  }
}

function cleanupStalePidFiles(state) {
  for (const pidPath of [state.supervisorPidPath, state.serverPidPath, state.webPidPath]) {
    const pid = readPid(pidPath);
    if (pid && isRunning(pid)) continue;
    rmSync(pidPath, { force: true });
  }
}

function printState(state) {
  console.log(`Logs:`);
  console.log(`  supervisor: ${state.supervisorLogPath}`);
  console.log(`  backend: ${state.serverLogPath}`);
  console.log(`  frontend: ${state.webLogPath}`);
  console.log(`PIDs:`);
  console.log(`  supervisor: ${state.supervisorPidPath}`);
  console.log(`  backend: ${state.serverPidPath}`);
  console.log(`  frontend: ${state.webPidPath}`);
}

function runPnpmSync(args) {
  execFileSync("pnpm", args, { env: process.env, stdio: "inherit" });
}

async function waitForEndpoints(endpoints, timeoutMs, onProgress) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextProgressAt = startedAt + START_PROGRESS_INTERVAL_MS;
  while (Date.now() < deadline) {
    const active = await Promise.all(endpoints.map((endpoint) => endpointActive(endpoint.url)));
    if (active.every(Boolean)) return { ok: true };
    const now = Date.now();
    if (now >= nextProgressAt) {
      onProgress?.({
        elapsedMs: now - startedAt,
        endpoints: endpoints.map((endpoint, index) => ({ ...endpoint, active: active[index] }))
      });
      nextProgressAt = now + START_PROGRESS_INTERVAL_MS;
    }
    await sleep(START_POLL_MS);
  }

  for (const endpoint of endpoints) {
    if (!(await endpointActive(endpoint.url))) return { ok: false, ...endpoint, elapsedMs: Date.now() - startedAt };
  }
  return { ok: true };
}

export function startupTimeoutMs(mode, environment = process.env) {
  const configured = environment.MUXPILOT_APP_START_TIMEOUT_MS;
  if (configured !== undefined && configured !== "") {
    const value = Number(configured);
    if (!Number.isInteger(value) || value < 1000) {
      throw new Error("MUXPILOT_APP_START_TIMEOUT_MS must be an integer of at least 1000 milliseconds");
    }
    return value;
  }
  return mode === "prod" ? PRODUCTION_START_TIMEOUT_MS : DEFAULT_START_TIMEOUT_MS;
}

export function formatStartupWaitProgress(label, elapsedMs, endpoints) {
  const states = endpoints.map((endpoint) => `${endpoint.name} ${endpoint.active ? "ready" : "pending"}`).join(", ");
  return `Still waiting for ${label} startup after ${formatWaitDuration(elapsedMs)} (${states}).`;
}

function formatWaitDuration(milliseconds) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function portOccupied(host, port) {
  return new Promise((resolveOccupied) => {
    const server = createServer();
    let listening = false;
    const done = (occupied) => {
      server.removeAllListeners();
      if (listening) server.close(() => resolveOccupied(occupied));
      else resolveOccupied(occupied);
    };

    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        done(true);
        return;
      }

      console.error(`Could not probe port ${port}: ${error.message}`);
      process.exit(1);
    });
    server.once("listening", () => {
      listening = true;
      done(false);
    });
    server.listen(port, host);
  });
}

async function endpointActive(url) {
  return new Promise((resolveActive) => {
    const parsed = new URL(url);
    const get = parsed.protocol === "https:" ? httpsGet : httpGet;
    const request = get(parsed, { rejectUnauthorized: false, timeout: HEALTH_CHECK_TIMEOUT_MS }, (response) => {
      response.resume();
      resolveActive((response.statusCode ?? 500) < 500);
    });
    request.on("timeout", () => {
      request.destroy();
      resolveActive(false);
    });
    request.on("error", () => resolveActive(false));
  });
}

async function readJsonEndpoint(url) {
  return new Promise((resolveJson) => {
    const parsed = new URL(url);
    const get = parsed.protocol === "https:" ? httpsGet : httpGet;
    const request = get(parsed, { rejectUnauthorized: false, timeout: HEALTH_CHECK_TIMEOUT_MS }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 500) {
          resolveJson(null);
          return;
        }
        try {
          resolveJson(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolveJson(null);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolveJson(null);
    });
    request.on("error", () => resolveJson(null));
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 1024 ** 3) return `${Math.round(value / 1024 ** 3 * 10) / 10} GiB`;
  return `${Math.round(value / 1024 ** 2)} MiB`;
}

export function resourceGovernorSessionScopeLines(snapshot) {
  if (snapshot.enabled) {
    return [`session scopes: active, ${snapshot.managedSessions ?? 0} managed, ${snapshot.unmanagedSessions ?? 0} unmanaged`];
  }
  if (snapshot.unavailableReason === "user_systemd_unavailable") {
    return ["session scopes: unavailable; run sudo loginctl enable-linger \"$USER\", then restart muxpilot"];
  }
  return ["session scopes: disabled"];
}

function findListeningPids(port) {
  return uniqueNumbers([
    ...runPidCommand("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]),
    ...findLinuxProcPids(port)
  ]);
}

function runPidCommand(command, args) {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return output.match(/\d+/g)?.map(Number) ?? [];
  } catch {
    return [];
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminatePid(pid, signal) {
  const pgid = processGroupId(pid);
  const currentPgid = processGroupId(process.pid);
  const groupPids = pgid ? pidsInProcessGroup(pgid).filter((groupPid) => groupPid !== process.pid) : [];
  if (pgid && pgid !== currentPgid) {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") console.warn(`Could not send ${signal} to process group ${pgid}: ${error.message}`);
    }
  }

  for (const groupPid of groupPids) {
    try {
      process.kill(groupPid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") console.warn(`Could not send ${signal} to PID ${groupPid}: ${error.message}`);
    }
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") console.warn(`Could not send ${signal} to PID ${pid}: ${error.message}`);
  }
}

function pidsInProcessGroup(pgid) {
  const pids = [];
  for (const entry of safeReadDir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (processGroupId(pid) === pgid) pids.push(pid);
  }
  return pids;
}

function processGroupId(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endOfCommand = stat.lastIndexOf(")");
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    const pgid = Number(fields[2]);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

function findLinuxProcPids(port) {
  const inodes = listeningSocketInodes(port);
  if (inodes.size === 0) return [];

  const pids = [];
  for (const entry of safeReadDir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;

    const fdPath = `/proc/${entry}/fd`;
    for (const fd of safeReadDir(fdPath)) {
      const target = safeReadLink(join(fdPath, fd));
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (match && inodes.has(match[1])) {
        pids.push(Number(entry));
        break;
      }
    }
  }

  return pids;
}

function listeningSocketInodes(port) {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();

  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const lines = safeReadFile(file).trim().split(/\r?\n/).slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const localAddress = fields[1];
      const state = fields[3];
      const inode = fields[9];

      if (state === "0A" && localAddress?.endsWith(`:${portHex}`) && inode) {
        inodes.add(inode);
      }
    }
  }

  return inodes;
}

function allLocalPorts() {
  return uniquePorts([...DEFAULT_DEV_PORTS, ...DEFAULT_PROD_PORTS, ...DEFAULT_SHADOW_PORTS, ...configuredPorts()]);
}

function modePorts(stopMode) {
  const config = modeConfig(stopMode);
  return uniquePorts([
    stopMode === "shadow" ? config.backendPort : process.env.MUXPILOT_PORT ?? config.backendPort,
    stopMode === "shadow" ? config.webPort : process.env.MUXPILOT_WEB_PORT ?? config.webPort
  ]);
}

function configuredPorts() {
  return [process.env.MUXPILOT_PORT, process.env.MUXPILOT_WEB_PORT].filter(Boolean);
}

function uniquePorts(values) {
  return uniqueNumbers(values.map(Number)).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function safeReadDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeReadFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeDirectory(path) {
  try {
    const details = lstatSync(path);
    return details.isDirectory() && !details.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRegularFile(path) {
  try {
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function safeReadLink(path) {
  try {
    return readlinkSync(path);
  } catch {
    return "";
  }
}

function safeRealPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function validPort(value, fallback) {
  const port = Number(value ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function applyRuntimeDefaults(config) {
  const bindHost = lanEnabled() ? "0.0.0.0" : "127.0.0.1";
  validateHttpsEnv();
  validateWebProtocolEnv();
  process.env.MUXPILOT_HOST ??= bindHost;
  process.env.MUXPILOT_PORT ??= config.backendPort;
  process.env.MUXPILOT_API_TARGET ??= `http://127.0.0.1:${process.env.MUXPILOT_PORT}`;
  process.env.MUXPILOT_WEB_PROTOCOL ??= httpsEnabled() ? "https" : "http";
  process.env.MUXPILOT_WEB_PORT ??= config.webPort;
  process.env.MUXPILOT_DATA_DIR ??= config.dataDir;
  process.env.MUXPILOT_DB_PATH ??= config.dbPath;
}

export function shadowIsolationEnvironment(root, source = process.env) {
  const dataDir = resolve(root, "data", "shadow");
  const governor = source.MUXPILOT_SHADOW_RESOURCE_GOVERNOR === "auto" ? "auto" : "off";
  return {
    MUXPILOT_SHADOW: "1",
    MUXPILOT_LAN_ENABLED: "0",
    MUXPILOT_HOST: "127.0.0.1",
    MUXPILOT_PORT: MODE_CONFIG.shadow.backendPort,
    MUXPILOT_API_TARGET: `http://127.0.0.1:${MODE_CONFIG.shadow.backendPort}`,
    MUXPILOT_WEB_PROTOCOL: "http",
    MUXPILOT_WEB_PORT: MODE_CONFIG.shadow.webPort,
    MUXPILOT_PWA_TRUST_PORT: "15880",
    MUXPILOT_DATA_DIR: dataDir,
    MUXPILOT_DB_PATH: join(dataDir, "muxpilot.db"),
    MUXPILOT_SKILL_HOME: resolve(root),
    MUXPILOT_GIT_WORKTREE_ROOT: join(dataDir, "git-worktrees"),
    MUXPILOT_GIT_SESSION_ROOT: join(dataDir, "sessions"),
    MUXPILOT_RESOURCE_GOVERNOR: governor,
    MUXPILOT_HEAVY_VALIDATION_DIR: join(dataDir, "heavy"),
    VITE_MUXPILOT_SHADOW: "1",
    ...(source.MUXPILOT_SHADOW_RUNTIME_PATH ? { PATH: source.MUXPILOT_SHADOW_RUNTIME_PATH } : {})
  };
}

export function shadowDependencyIsolation(root) {
  const checkout = resolve(root);
  const expected = safeRealPath(join(checkout, "packages", "core"));
  const server = safeRealPath(join(checkout, "apps", "server", "node_modules", "@muxpilot", "core"));
  const web = safeRealPath(join(checkout, "apps", "web", "node_modules", "@muxpilot", "core"));
  return { expected, server, web, isolated: Boolean(expected && server === expected && web === expected) };
}

function assertShadowDependencyIsolation(root) {
  if (shadowDependencyIsolation(root).isolated) return;
  console.error("Shadow mode requires dependencies installed for this checkout; @muxpilot/core currently resolves outside it or is missing.");
  console.error("Run pnpm install --frozen-lockfile in a standalone worktree. In a muxpilot-managed worktree, localize its registered node_modules dependencies first.");
  process.exit(1);
}

function applyShadowIsolation(config) {
  const shadow = shadowIsolationEnvironment(process.cwd());
  for (const key of ["MUXPILOT_HTTPS_CERT", "MUXPILOT_HTTPS_KEY", "MUXPILOT_PWA_TRUST_DIR", "MUXPILOT_CORS_ORIGINS"]) {
    delete process.env[key];
  }
  Object.assign(process.env, shadow);
  mkdirSync(shadow.MUXPILOT_DATA_DIR, { recursive: true, mode: 0o700 });
  chmodSync(shadow.MUXPILOT_DATA_DIR, 0o700);
  applyRuntimeDefaults(config);
}

export function shadowOwnedSystemdUnits(dataDir) {
  const root = resolve(dataDir);
  const units = new Set();
  const appServerRoot = join(root, "runtime", "app-server-sessions");
  for (const capabilityId of safeReadDir(appServerRoot)) {
    if (!APP_SERVER_CAPABILITY_ID.test(capabilityId)) continue;
    const runtimeDir = join(appServerRoot, capabilityId);
    if (!safeDirectory(runtimeDir)) continue;
    const marker = safeRegularFile(join(runtimeDir, "environment"));
    if (!marker.split(/\r?\n/).includes('MUXPILOT_SHADOW="1"')) continue;
    units.add(`muxpilot-session-${capabilityId}.service`);
  }
  const heavyRoot = join(root, "heavy", "runs");
  for (const runId of safeReadDir(heavyRoot)) {
    if (!/^[a-z0-9-]+$/.test(runId)) continue;
    const runDir = join(heavyRoot, runId);
    if (!safeDirectory(runDir)) continue;
    try {
      const owner = JSON.parse(safeRegularFile(join(runDir, "owner.json")));
      if (typeof owner.resourceUnit === "string" && HEAVY_RESOURCE_UNIT.test(owner.resourceUnit)) {
        units.add(owner.resourceUnit);
      }
    } catch {
      // Incomplete or corrupt queue metadata is not proof of shadow ownership.
    }
  }
  return [...units].sort();
}

function stopShadowSystemdUnits(dataDir) {
  const units = shadowOwnedSystemdUnits(dataDir);
  for (const unit of units) {
    try {
      execFileSync("systemctl", ["--user", "stop", unit], { stdio: ["ignore", "ignore", "pipe"] });
      console.log(`Stopped shadow-owned unit ${unit}.`);
    } catch (error) {
      if (isMissingSystemdUnitStopError(error)) continue;
      console.warn(`Could not stop shadow-owned unit ${unit}: ${systemdErrorDetail(error)}`);
    }
  }
}

export function isMissingSystemdUnitStopError(error) {
  return /\bUnit\s+\S+\s+not (?:loaded|found)\.\s*$/m.test(systemdErrorDetail(error));
}

function systemdErrorDetail(error) {
  if (error && typeof error === "object" && "stderr" in error && error.stderr) return String(error.stderr).trim();
  return error instanceof Error ? error.message : String(error);
}

function lanEnabled() {
  const normalized = process.env.MUXPILOT_LAN_ENABLED?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function httpsEnabled() {
  return Boolean(process.env.MUXPILOT_HTTPS_CERT && process.env.MUXPILOT_HTTPS_KEY);
}

function validateHttpsEnv() {
  const cert = process.env.MUXPILOT_HTTPS_CERT;
  const key = process.env.MUXPILOT_HTTPS_KEY;
  if (!cert && !key) return;
  if (!cert || !key) {
    console.error("MUXPILOT_HTTPS_CERT and MUXPILOT_HTTPS_KEY must be set together.");
    process.exit(1);
  }
  if (!existsSync(cert)) {
    console.error(`MUXPILOT_HTTPS_CERT does not exist: ${cert}`);
    process.exit(1);
  }
  if (!existsSync(key)) {
    console.error(`MUXPILOT_HTTPS_KEY does not exist: ${key}`);
    process.exit(1);
  }
}

function validateWebProtocolEnv() {
  const protocol = process.env.MUXPILOT_WEB_PROTOCOL;
  if (!protocol) return;
  if (protocol !== "http" && protocol !== "https") {
    console.error("MUXPILOT_WEB_PROTOCOL must be either http or https.");
    process.exit(1);
  }
  if (protocol === "https" && !httpsEnabled()) {
    console.error("MUXPILOT_WEB_PROTOCOL=https requires MUXPILOT_HTTPS_CERT and MUXPILOT_HTTPS_KEY.");
    process.exit(1);
  }
  if (protocol === "http" && httpsEnabled()) {
    console.error("MUXPILOT_WEB_PROTOCOL=http cannot be combined with MUXPILOT_HTTPS_CERT and MUXPILOT_HTTPS_KEY.");
    process.exit(1);
  }
}

function loadDotenv() {
  loadDotenvFile(findDotenv(process.cwd(), ".env"), false);
  loadDotenvFile(findDotenv(process.cwd(), ".env.local"), true);
}

function loadDotenvFile(path, override) {
  if (!path) return;

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (!parsed) continue;
    if (!override && process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
  }
}

function findDotenv(startDir, filename) {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function parseDotenvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;

  const [, key, rawValue] = match;
  return { key, value: unquoteDotenvValue(rawValue.trim()) };
}

function unquoteDotenvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, "");
}

function normalizeLogProcesses(processes) {
  const normalized = processes.flatMap((value) => (value === "all" ? PROCESSES : [value]));
  const unique = [...new Set(normalized)];
  for (const processName of unique) {
    if (!PROCESSES.includes(processName)) {
      console.error(`Unknown log process "${processName}". Use server, web, supervisor, or all.`);
      process.exit(1);
    }
  }
  return unique;
}

function normalizeLineCount(value) {
  const lines = Number(value);
  return Number.isInteger(lines) && lines > 0 ? lines : 80;
}

function readLastLines(path, lines) {
  const content = safeReadFile(path);
  if (!content) return existsSync(path) ? "" : `(no log file at ${path})\n`;
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  const allLines = trimmed.split(/\r?\n/);
  return `${allLines.slice(-lines).join("\n")}\n`;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readRange(path, start, end) {
  if (end <= start) return "";
  const content = safeReadFile(path);
  return content.slice(start, end);
}

function assertMode(mode, command) {
  if (!MODES.includes(mode)) {
    console.error(`Usage: pnpm app ${command} [${MODES.join("|")}]`);
    process.exit(1);
  }
}

function assertModeOrAll(mode, command) {
  if (mode !== "all" && !MODES.includes(mode)) {
    console.error(`Usage: pnpm app ${command} [${MODES.join("|")}|all]`);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function modeLabel(mode) {
  if (mode === "all") return "local";
  return `local ${mode}`;
}

function capitalize(value) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
