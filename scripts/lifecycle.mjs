import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

const HEALTH_CHECK_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 30000;
const START_POLL_MS = 500;
const STOP_GRACE_MS = 750;
const DEFAULT_DEV_PORTS = ["4177", "5177"];
const DEFAULT_PROD_PORTS = ["12777", "12778"];

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
    label: "production preview",
    backendPort: "12777",
    webPort: "12778",
    dataDir: "./data/prod",
    dbPath: "./data/prod/muxpilot.db",
    build: true,
    backendArgs: ["--filter", "@muxpilot/server", "start"],
    webArgs: ["--filter", "@muxpilot/web", "start"]
  }
};

export async function startMode(mode) {
  const config = modeConfig(mode);
  loadDotenv();
  applyRuntimeDefaults(config);

  const state = runtimeState(mode);
  mkdirSync(state.dir, { recursive: true });

  const backendPort = validPort(process.env.MUXPILOT_PORT, Number(config.backendPort));
  const webPort = validPort(process.env.MUXPILOT_WEB_PORT, Number(config.webPort));
  const webProtocol = process.env.MUXPILOT_WEB_PROTOCOL ?? "http";
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const webUrl = `${webProtocol}://127.0.0.1:${webPort}`;

  cleanupStalePidFiles(state);

  const [backendActive, webActive, backendPortOccupied, webPortOccupied] = await Promise.all([
    endpointActive(`${backendUrl}/healthz`),
    endpointActive(webUrl),
    portOccupied("127.0.0.1", backendPort),
    portOccupied("127.0.0.1", webPort)
  ]);

  if (backendActive && webActive) {
    console.log(`${capitalize(config.label)} is already active. Reusing ${webUrl}.`);
    printState(state);
    return;
  }

  if (backendPortOccupied && !backendActive) {
    console.error(`Backend port ${backendPort} is already in use, but ${backendUrl}/healthz did not respond.`);
    console.error(`Not starting a duplicate backend. Reuse the existing process if it is intentional, or run pnpm stop:${mode} before pnpm start:${mode}.`);
    process.exit(1);
  }

  if (webPortOccupied && !webActive) {
    console.error(`Frontend port ${webPort} is already in use, but ${webUrl} did not respond.`);
    console.error(`Not starting a duplicate frontend. Reuse the existing process if it is intentional, or run pnpm stop:${mode} before pnpm start:${mode}.`);
    process.exit(1);
  }

  if (config.build) runPnpmSync(["build"]);

  const started = [];
  if (!backendActive) {
    started.push("backend");
    spawnManaged("backend", config.backendArgs, state.backendPidPath, state.backendLogPath);
  }
  if (!webActive) {
    started.push("frontend");
    spawnManaged("frontend", config.webArgs, state.webPidPath, state.webLogPath);
  }

  console.log(`Starting ${config.label} ${started.join(" and ")} in the background...`);

  const ready = await waitForEndpoints([
    { name: "backend", url: `${backendUrl}/healthz` },
    { name: "frontend", url: webUrl }
  ]);

  if (!ready.ok) {
    console.error(`Timed out waiting for ${ready.name} at ${ready.url}.`);
    printState(state);
    process.exit(1);
  }

  console.log(`${capitalize(config.label)} is ready at ${webUrl} with backend ${backendUrl}.`);
  printState(state);
}

export async function stopMode(mode) {
  if (!["all", "dev", "prod"].includes(mode)) {
    console.error("Usage: node scripts/stop.mjs [all|dev|prod]");
    process.exit(1);
  }

  loadDotenv();

  const modes = mode === "all" ? ["dev", "prod"] : [mode];
  const pidCandidates = new Map();

  for (const stopMode of modes) {
    for (const candidate of readStatePids(stopMode)) {
      pidCandidates.set(candidate.pid, candidate);
    }
  }

  const ports = mode === "all" ? allLocalPorts() : modePorts(mode);
  for (const port of ports) {
    const pids = findListeningPids(port);
    if (pids.length > 0) {
      for (const pid of pids) {
        pidCandidates.set(pid, { pid, source: `port ${port}` });
      }
    }
  }

  const allPids = [...pidCandidates.keys()].filter((pid) => pid !== process.pid && isRunning(pid));

  if (allPids.length === 0) {
    console.log(`No ${modeLabel(mode)} servers found on ports ${ports.join(", ")}.`);
    removePidFiles(modes);
    return;
  }

  for (const candidate of allPids) {
    console.log(`Stopping PID ${candidate} (${pidCandidates.get(candidate)?.source ?? "runtime state"})`);
  }

  for (const pid of allPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        console.warn(`Could not terminate PID ${pid}: ${error.message}`);
      }
    }
  }

  await sleep(STOP_GRACE_MS);

  const remaining = allPids.filter(isRunning);
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        console.warn(`Could not force-kill PID ${pid}: ${error.message}`);
      }
    }
  }

  removePidFiles(modes);
  console.log(`${capitalize(modeLabel(mode))} server stop complete.`);
}

function modeConfig(mode) {
  const config = MODE_CONFIG[mode];
  if (!config) {
    console.error("Usage: node scripts/start-[dev|prod].mjs");
    process.exit(1);
  }
  return config;
}

function runtimeState(mode) {
  const dir = resolve("data", "runtime", mode);
  return {
    dir,
    backendPidPath: join(dir, "server.pid"),
    webPidPath: join(dir, "web.pid"),
    backendLogPath: join(dir, "server.log"),
    webLogPath: join(dir, "web.log")
  };
}

function spawnManaged(name, args, pidPath, logPath) {
  appendFileSync(logPath, `\n--- ${new Date().toISOString()} starting ${name}: pnpm ${args.join(" ")} ---\n`);
  const logFd = openSync(logPath, "a");

  try {
    const child = spawn("pnpm", args, {
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd]
    });

    child.on("error", (error) => {
      console.error(`Could not start ${name}: ${error.message}`);
      process.exit(1);
    });
    child.unref();
    writeFileSync(pidPath, `${child.pid}\n`);
  } finally {
    closeSync(logFd);
  }
}

function runPnpmSync(args) {
  execFileSync("pnpm", args, { env: process.env, stdio: "inherit" });
}

async function waitForEndpoints(endpoints) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const endpoint of endpoints) {
      if (!(await endpointActive(endpoint.url))) {
        await sleep(START_POLL_MS);
        continue;
      }
    }
    const active = await Promise.all(endpoints.map((endpoint) => endpointActive(endpoint.url)));
    if (active.every(Boolean)) return { ok: true };
  }

  for (const endpoint of endpoints) {
    if (!(await endpointActive(endpoint.url))) {
      return { ok: false, ...endpoint };
    }
  }
  return { ok: true };
}

function printState(state) {
  console.log(`Logs:`);
  console.log(`  backend: ${state.backendLogPath}`);
  console.log(`  frontend: ${state.webLogPath}`);
  console.log(`PIDs:`);
  console.log(`  backend: ${state.backendPidPath}`);
  console.log(`  frontend: ${state.webPidPath}`);
}

function cleanupStalePidFiles(state) {
  for (const pidPath of [state.backendPidPath, state.webPidPath]) {
    const pid = readPid(pidPath);
    if (pid && isRunning(pid)) continue;
    rmSync(pidPath, { force: true });
  }
}

function readStatePids(mode) {
  const state = runtimeState(mode);
  return [
    { pid: readPid(state.backendPidPath), source: `${mode} backend pid file` },
    { pid: readPid(state.webPidPath), source: `${mode} frontend pid file` }
  ].filter((candidate) => candidate.pid);
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
    rmSync(state.backendPidPath, { force: true });
    rmSync(state.webPidPath, { force: true });
  }
}

function portOccupied(host, port) {
  return new Promise((resolveOccupied) => {
    const server = createServer();
    let listening = false;
    const done = (occupied) => {
      server.removeAllListeners();
      if (listening) {
        server.close(() => resolveOccupied(occupied));
      } else {
        resolveOccupied(occupied);
      }
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
  return uniquePorts([...DEFAULT_DEV_PORTS, ...DEFAULT_PROD_PORTS, ...configuredPorts()]);
}

function modePorts(stopMode) {
  const [defaultBackendPort, defaultWebPort] =
    stopMode === "prod" ? DEFAULT_PROD_PORTS : DEFAULT_DEV_PORTS;
  return uniquePorts([
    process.env.MUXPILOT_PORT ?? defaultBackendPort,
    process.env.MUXPILOT_WEB_PORT ?? defaultWebPort
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

function safeReadLink(path) {
  try {
    return readlinkSync(path);
  } catch {
    return "";
  }
}

function validPort(value, fallback) {
  const port = Number(value ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
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
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, "");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function modeLabel(mode) {
  if (mode === "all") return "local";
  return `local ${mode}`;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
