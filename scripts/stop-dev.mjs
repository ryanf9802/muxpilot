import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DEV_PORTS = ["4177", "5177"];
const DEFAULT_PROD_PORTS = ["12777", "12778"];
const mode = process.argv[2] === "prod" ? "prod" : "dev";

const ports = uniquePorts(mode === "prod" ? DEFAULT_PROD_PORTS : DEFAULT_DEV_PORTS);
const pidsByPort = new Map();

for (const port of ports) {
  const pids = findListeningPids(port);
  if (pids.length > 0) {
    pidsByPort.set(port, pids);
  }
}

const allPids = [...new Set([...pidsByPort.values()].flat())].filter((pid) => pid !== process.pid);

if (allPids.length === 0) {
  console.log(`No local ${mode} servers found on ports ${ports.join(", ")}.`);
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

console.log(`Local ${mode} server stop complete.`);

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
