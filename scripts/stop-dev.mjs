import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_DEV_PORTS = ["4177", "5177"];
const DEFAULT_PROD_PORTS = ["12777", "12778"];
const mode = process.argv[2] ?? "all";

if (!["all", "dev", "prod"].includes(mode)) {
  console.error("Usage: node scripts/stop-dev.mjs [all|dev|prod]");
  process.exit(1);
}

loadDotenv();

const ports = mode === "all" ? allLocalPorts() : modePorts(mode);
const pidsByPort = new Map();

for (const port of ports) {
  const pids = findListeningPids(port);
  if (pids.length > 0) {
    pidsByPort.set(port, pids);
  }
}

const allPids = [...new Set([...pidsByPort.values()].flat())].filter((pid) => pid !== process.pid);

if (allPids.length === 0) {
  console.log(`No ${modeLabel()} servers found on ports ${ports.join(", ")}.`);
  process.exit(0);
}

for (const [port, pids] of pidsByPort) {
  console.log(`Port ${port}: stopping PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")}`);
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

await sleep(750);

const remaining = allPids.filter(isRunning);
if (remaining.length > 0) {
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        console.warn(`Could not force-kill PID ${pid}: ${error.message}`);
      }
    }
  }
}

console.log(`${capitalize(modeLabel())} server stop complete.`);

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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function uniquePorts(values) {
  return uniqueNumbers(values.map(Number)).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
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

function modeLabel() {
  if (mode === "all") return "local";
  return `local ${mode}`;
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
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
