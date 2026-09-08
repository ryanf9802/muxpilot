#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostScopedShadowEnvironment,
  isMuxpilotSessionCgroup,
  isShadowExecutionCgroup,
  shadowSocketPathSafety,
  shadowScopeUnitName,
  verifyReusableDependencyInstall,
  verifyProductionUnchanged
} from "./shadow-environment.mjs";

let shadowStartAttempted = false;
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: start-shadow.mjs --expected-commit <sha> --prod-checkout <path> [--dependencies-installed-at <sha>] [--preflight] [--stop-checkout <path>]");
  process.exit(0);
}

const expectedCommit = optionValue(args, "--expected-commit");
const dependenciesInstalledAt = optionValue(args, "--dependencies-installed-at");
const prodRoot = resolve(optionValue(args, "--prod-checkout") ?? "");
const stopCheckout = optionValue(args, "--stop-checkout");
if (!expectedCommit) fail("--expected-commit is required");
if (!optionValue(args, "--prod-checkout")) fail("--prod-checkout is required");
if (args.includes("--dependencies-installed-at") && !dependenciesInstalledAt) fail("--dependencies-installed-at requires a commit");
if (args.includes("--stop-checkout") && !stopCheckout) fail("--stop-checkout requires a path");
if (stopCheckout && dependenciesInstalledAt) fail("--dependencies-installed-at cannot be used with --stop-checkout");

const helperRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
const shadowRoot = stopCheckout ? resolve(stopCheckout) : helperRoot;
const head = git(shadowRoot, ["rev-parse", "HEAD"]);
if (head !== expectedCommit) fail(`expected commit ${expectedCommit}, but shadow checkout is at ${head}`);
if (git(shadowRoot, ["status", "--porcelain"])) fail("shadow checkout is dirty");
if (resolve(shadowRoot) === prodRoot) fail("shadow checkout must not be the production checkout");
if (gitCommonDir(shadowRoot) !== gitCommonDir(prodRoot)) fail("shadow and production checkouts are not from the same Git repository");
if (gitCommonDir(helperRoot) !== gitCommonDir(prodRoot)) fail("shadow helper and production checkouts are not from the same Git repository");
const socketSafety = shadowSocketPathSafety(shadowRoot);
if (!socketSafety.safe) {
  const unsafe = socketSafety.unsafePaths.map(({ path, bytes }) => `${path} (${bytes} bytes)`).join(", ");
  fail(`shadow checkout path is too long for Unix sockets (maximum ${socketSafety.maxBytes} bytes): ${unsafe}`);
}

const ownCgroup = readCgroup("self");
if (!isShadowExecutionCgroup(ownCgroup)) {
  if (args.includes("--scoped-relaunch")) fail(`systemd relaunch remained in ${ownCgroup}; a non-session user scope is required`);
  relaunchInHostScope();
}

const before = await productionSnapshot(prodRoot);
if (stopCheckout) {
  runDirectPnpm(["app", "stop", "shadow"], "shadow stop");
  for (const port of [14177, 15177]) {
    if (!await waitForPortAvailable(port)) fail(`shadow port ${port} remained occupied after stop`);
  }
  const after = await productionSnapshot(prodRoot);
  try {
    verifyProductionUnchanged(before, after);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(
    `MUXPILOT_SHADOW_STOPPED_OUTSIDE_SESSION_SCOPE commit=${expectedCommit} checkout=${shadowRoot} cgroup=${ownCgroup} prodSupervisor=${after.processes.supervisor.pid} prodServer=${after.processes.server.pid} prodWeb=${after.processes.web.pid}`
  );
  process.exit(0);
}
if (args.includes("--preflight")) {
  console.log(`MUXPILOT_SHADOW_START_PREFLIGHT_OK commit=${head} cgroup=${ownCgroup} prodServer=${before.processes.server.pid}`);
  process.exit(0);
}

for (const port of [14177, 15177]) {
  if (!await portAvailable(port)) fail(`shadow port ${port} is already occupied; refusing to adopt or stop an existing process`);
}

if (dependenciesInstalledAt) {
  try {
    verifyReusableDependencyInstall(shadowRoot, dependenciesInstalledAt, head);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`Skipping dependency installation; dependency inputs are unchanged since ${dependenciesInstalledAt}.`);
} else {
  runDirectPnpm(["install", "--frozen-lockfile"], "dependency installation");
}
if (git(shadowRoot, ["status", "--porcelain"])) fail("frozen dependency installation changed the shadow checkout");
shadowStartAttempted = true;
runDirectPnpm(["app", "start", "shadow"], "shadow startup");

const shadowHealth = await health("http://127.0.0.1:14177/healthz");
if (!shadowHealth?.ok || shadowHealth.shadowMode !== true) fail("shadow health endpoint did not identify an active shadow server");

const shadowRuntime = resolve(shadowRoot, "data", "runtime", "shadow");
const shadowProcesses = Object.fromEntries(["supervisor", "server", "web"].map((role) => {
  const pid = readPid(join(shadowRuntime, `${role}.pid`), `shadow ${role}`);
  process.kill(pid, 0);
  const cgroup = readCgroup(pid);
  if (isMuxpilotSessionCgroup(cgroup)) fail(`shadow ${role} PID ${pid} remained in muxpilot session cgroup ${cgroup}`);
  if (cgroup !== ownCgroup) fail(`shadow ${role} PID ${pid} is in ${cgroup}, not shadow start cgroup ${ownCgroup}`);
  return [role, { pid, cgroup }];
}));

const after = await productionSnapshot(prodRoot);
try {
  verifyProductionUnchanged(before, after);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (git(shadowRoot, ["rev-parse", "HEAD"]) !== expectedCommit) fail("shadow checkout commit changed during startup");
if (git(shadowRoot, ["status", "--porcelain"])) fail("shadow checkout became dirty during startup");

console.log(
  `MUXPILOT_SHADOW_STARTED_OUTSIDE_SESSION_SCOPE commit=${expectedCommit} url=http://127.0.0.1:15177 supervisor=${shadowProcesses.supervisor.pid} server=${shadowProcesses.server.pid} web=${shadowProcesses.web.pid} cgroup=${ownCgroup} prodSupervisor=${after.processes.supervisor.pid} prodServer=${after.processes.server.pid} prodWeb=${after.processes.web.pid}`
);

function runDirectPnpm(pnpmArgs, description) {
  const result = spawnSync("pnpm", pnpmArgs, {
    cwd: shadowRoot,
    env: hostScopedShadowEnvironment(process.env),
    stdio: "inherit"
  });
  if (result.error) fail(`${description} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${description} exited with status ${result.status ?? "unknown"}`);
}

async function productionSnapshot(root) {
  const [response, sessionResponse] = await Promise.all([
    health("http://127.0.0.1:12777/healthz"),
    health("http://127.0.0.1:12777/api/sessions")
  ]);
  if (!response?.ok) fail("production health endpoint is unavailable");
  if (!Array.isArray(sessionResponse?.sessions)) fail("production session inventory is unavailable");
  const runtime = resolve(root, "data", "runtime", "prod");
  const processes = Object.fromEntries(["supervisor", "server", "web"].map((role) => {
    const pid = readPid(join(runtime, `${role}.pid`), `production ${role}`);
    process.kill(pid, 0);
    return [role, { pid, cgroup: readCgroup(pid) }];
  }));
  return {
    processes,
    tmuxPanes: listTmuxPanes(),
    appServerServices: listActiveAppServerServices(),
    sessions: sessionResponse.sessions.map((session) => ({
      id: String(session.id ?? ""),
      codexSessionId: session.codexSessionId == null ? null : String(session.codexSessionId),
      driverKind: session.driverKind == null ? null : String(session.driverKind),
      tmuxPaneId: session.tmux?.paneId == null ? null : String(session.tmux.paneId),
      tmuxPid: session.tmux?.pid == null ? null : Number(session.tmux.pid)
    })).sort((left, right) => left.id.localeCompare(right.id))
  };
}

function listTmuxPanes() {
  const environment = { ...process.env };
  delete environment.TMUX;
  delete environment.TMUX_TMPDIR;
  const result = spawnSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}"], {
    encoding: "utf8",
    env: environment
  });
  if (result.error || result.status !== 0) fail("could not snapshot production tmux panes");
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [session, window, pane, rawPid] = line.split("\t");
    const pid = Number(rawPid);
    if (!session || !window || !pane || !Number.isInteger(pid) || pid <= 0) fail("invalid production tmux pane snapshot");
    return { identity: `${session}:${window}:${pane}`, pid };
  }).sort((left, right) => left.identity.localeCompare(right.identity));
}

function listActiveAppServerServices() {
  const listed = spawnSync("systemctl", ["--user", "list-units", "--type=service", "--state=active", "--plain", "--no-legend", "muxpilot-session-*.service"], { encoding: "utf8" });
  if (listed.error || listed.status !== 0) fail("could not snapshot muxpilot app-server services");
  return listed.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(/\s+/)[0]).map((unit) => {
    if (!/^muxpilot-session-[a-f0-9]{24}\.service$/.test(unit)) fail(`invalid app-server unit in snapshot: ${unit}`);
    const shown = spawnSync("systemctl", ["--user", "show", unit, "--property=ActiveState", "--property=MainPID", "--no-pager"], { encoding: "utf8" });
    if (shown.error || shown.status !== 0) fail(`could not inspect ${unit}`);
    const properties = Object.fromEntries(shown.stdout.trim().split(/\r?\n/).map((entry) => entry.split("=", 2)));
    return { unit, activeState: properties.ActiveState ?? "", mainPid: Number(properties.MainPID ?? 0) };
  }).sort((left, right) => left.unit.localeCompare(right.unit));
}

async function health(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function portAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.once("listening", () => server.close(() => resolveAvailable(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function waitForPortAvailable(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await portAvailable(port)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return portAvailable(port);
}

function relaunchInHostScope() {
  const unit = shadowScopeUnitName(process.pid, randomBytes(4).toString("hex"));
  const childArgs = args.filter((arg) => arg !== "--scoped-relaunch");
  childArgs.push("--scoped-relaunch");
  const relaunched = spawnSync("systemd-run", [
    "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
    process.execPath, fileURLToPath(import.meta.url), ...childArgs
  ], { cwd: shadowRoot, env: process.env, stdio: "inherit" });
  if (relaunched.error) fail(`could not enter host shadow scope: ${relaunched.error.message}; use host/elevated execution`);
  if (relaunched.status !== 0) fail(`host shadow scope exited with status ${relaunched.status ?? "unknown"}`);
  process.exit(0);
}

function git(root, gitArgs) {
  const result = spawnSync("git", ["-C", root, ...gitArgs], { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`git ${gitArgs.join(" ")} failed in ${root}`);
  return result.stdout.trim();
}

function gitCommonDir(root) {
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  return resolve(root, common);
}

function optionValue(values, name) {
  const index = values.indexOf(name);
  const value = index === -1 ? null : values[index + 1] ?? null;
  return value?.startsWith("--") ? null : value;
}

function readPid(path, role) {
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) fail(`invalid ${role} PID file at ${path}`);
  return pid;
}

function readCgroup(pid) {
  const lines = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n");
  const unified = lines.find((line) => line.startsWith("0::"));
  if (!unified) fail(`could not read unified cgroup for ${pid}`);
  return unified.slice(3);
}

function fail(message) {
  if (shadowStartAttempted) {
    shadowStartAttempted = false;
    spawnSync("pnpm", ["app", "stop", "shadow"], { cwd: shadowRoot, env: process.env, stdio: "inherit" });
  }
  console.error(`muxpilot shadow start refused: ${message}`);
  process.exit(1);
}
