import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

loadDotenv();
applyProdRuntimeDefaults();

const HEALTH_CHECK_TIMEOUT_MS = 5000;
const backendPort = validPort(process.env.MUXPILOT_PORT, 12777);
const webPort = validPort(process.env.MUXPILOT_WEB_PORT, 12778);
const webProtocol = process.env.MUXPILOT_WEB_PROTOCOL ?? "http";
const backendUrl = `http://127.0.0.1:${backendPort}`;
const webUrl = `${webProtocol}://127.0.0.1:${webPort}`;

const [backendActive, webActive, backendPortOccupied, webPortOccupied] = await Promise.all([
  endpointActive(`${backendUrl}/healthz`),
  endpointActive(webUrl),
  portOccupied("127.0.0.1", backendPort),
  portOccupied("127.0.0.1", webPort)
]);

if (backendActive && webActive) {
  console.log(`Production preview is already active. Reusing ${webUrl}.`);
  process.exit(0);
}

if (backendPortOccupied && !backendActive) {
  console.error(`Production backend port ${backendPort} is already in use, but ${backendUrl}/healthz did not respond.`);
  console.error("Not starting a duplicate backend. Reuse the existing process if it is intentional, or run pnpm prod:stop before pnpm run:prod.");
  process.exit(1);
}

if (webPortOccupied && !webActive) {
  console.error(`Production frontend port ${webPort} is already in use, but ${webUrl} did not respond.`);
  console.error("Not starting a duplicate frontend. Reuse the existing process if it is intentional, or run pnpm prod:stop before pnpm run:prod.");
  process.exit(1);
}

await runPnpm(["build"]);

if (backendActive) {
  console.log(`Production backend is already active on ${backendUrl}; starting frontend on ${webUrl}.`);
  await runPnpm(["--filter", "@muxpilot/web", "run:prod"]);
} else if (webActive) {
  console.log(`Production frontend is already active on ${webUrl}; starting backend on ${backendUrl}.`);
  await runPnpm(["--filter", "@muxpilot/server", "run:prod"]);
} else {
  console.log(`Starting production preview at ${webUrl} with backend ${backendUrl}.`);
  await runPnpm(["--parallel", "--filter", "@muxpilot/server", "--filter", "@muxpilot/web", "run:prod"]);
}

function runPnpm(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("pnpm", args, { stdio: "inherit", env: process.env });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveRun();
        return;
      }
      if (code === 0) resolveRun();
      else process.exit(code ?? 1);
    });
  });
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

function validPort(value, fallback) {
  const port = Number(value ?? fallback);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function applyProdRuntimeDefaults() {
  const bindHost = lanEnabled() ? "0.0.0.0" : "127.0.0.1";
  validateHttpsEnv();
  validateWebProtocolEnv();
  process.env.MUXPILOT_HOST ??= bindHost;
  process.env.MUXPILOT_PORT ??= "12777";
  process.env.MUXPILOT_API_TARGET ??= `http://127.0.0.1:${process.env.MUXPILOT_PORT}`;
  process.env.MUXPILOT_WEB_PROTOCOL ??= httpsEnabled() ? "https" : "http";
  process.env.MUXPILOT_WEB_PORT ??= "12778";
  process.env.MUXPILOT_DATA_DIR ??= "./data/prod";
  process.env.MUXPILOT_DB_PATH ??= "./data/prod/muxpilot.db";
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

function loadDotenvFile(dotenvPath, override) {
  if (!dotenvPath) return;

  const lines = readFileSync(dotenvPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || (!override && process.env[key] !== undefined)) continue;

    process.env[key] = unquoteValue(trimmed.slice(separatorIndex + 1).trim());
  }
}

function unquoteValue(value) {
  const quote = value[0];
  if ((quote === "\"" || quote === "'") && value.at(-1) === quote) {
    return value.slice(1, -1);
  }
  return value;
}

function findDotenv(start, filename) {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
