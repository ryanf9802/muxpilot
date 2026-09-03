import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function hostScopedHeavyEnvironment(environment) {
  return { ...environment, MUXPILOT_HEAVY_QUEUE_ENABLED: "0" };
}

const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const CAPABILITY_ID_EXAMPLE = "f".repeat(24);

export function shadowSocketPathSafety(shadowRoot) {
  const dataDir = resolve(shadowRoot, "data", "shadow");
  const paths = [
    join(dataDir, "runtime", "git-workflow-broker", "broker.sock"),
    join(dataDir, "runtime", "docker-guard.sock"),
    join(dataDir, "runtime", "session-orchestration.sock"),
    join(dataDir, "runtime", "app-server-sessions", CAPABILITY_ID_EXAMPLE, "app-server.sock")
  ];
  const unsafePaths = paths
    .map((path) => ({ path, bytes: Buffer.byteLength(path) }))
    .filter(({ bytes }) => bytes > MAX_UNIX_SOCKET_PATH_BYTES);
  return { safe: unsafePaths.length === 0, maxBytes: MAX_UNIX_SOCKET_PATH_BYTES, paths, unsafePaths };
}

const SESSION_SCOPE_PATTERN = /(?:^|\/)muxpilot-session-[a-f0-9]{24}\.scope(?:\/|$)/;
const SHADOW_SCOPE_PATTERN = /(?:^|\/)muxpilot-shadow-start-\d+-[a-f0-9]{8}\.scope(?:\/|$)/;

export function isMuxpilotSessionCgroup(cgroup) {
  return SESSION_SCOPE_PATTERN.test(cgroup);
}

export function isShadowExecutionCgroup(cgroup) {
  return cgroup === "/init.scope" || SHADOW_SCOPE_PATTERN.test(cgroup);
}

export function shadowScopeUnitName(pid, suffix) {
  return `muxpilot-shadow-start-${pid}-${suffix}`;
}

export function verifyReusableDependencyInstall(root, installedCommit, requestedCommit) {
  if (!/^[0-9a-f]{40}$/.test(installedCommit)) {
    throw new Error("dependency installation commit must be an exact lowercase 40-character Git SHA");
  }
  const resolvedCommit = git(root, ["rev-parse", "--verify", `${installedCommit}^{commit}`]);
  if (resolvedCommit !== installedCommit) {
    throw new Error(`dependency installation commit resolved to unexpected identity ${resolvedCommit}`);
  }
  const ancestor = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", installedCommit, requestedCommit], {
    encoding: "utf8"
  });
  if (ancestor.error) throw new Error(`could not compare dependency installation commit: ${ancestor.error.message}`);
  if (ancestor.status !== 0 && ancestor.status !== 1) {
    throw new Error(`could not compare dependency installation commit (git exited ${ancestor.status ?? "unknown"})`);
  }
  if (ancestor.status !== 0) {
    throw new Error(`dependency installation commit ${installedCommit} is not an ancestor of ${requestedCommit}`);
  }
  const changedInputs = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", `${installedCommit}..${requestedCommit}`])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(isDependencyInstallInput);
  if (changedInputs.length > 0) {
    throw new Error(`dependency inputs changed since ${installedCommit}: ${changedInputs.join(", ")}`);
  }
  return { installedCommit, requestedCommit };
}

export function isDependencyInstallInput(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized === "package.json"
    || normalized.endsWith("/package.json")
    || normalized === "pnpm-lock.yaml"
    || normalized === "pnpm-workspace.yaml"
    || normalized === ".npmrc"
    || normalized.endsWith("/.npmrc")
    || normalized === "pnpmfile.cjs"
    || normalized.endsWith("/pnpmfile.cjs")
    || normalized === ".pnpmfile.cjs"
    || normalized.endsWith("/.pnpmfile.cjs")
    || normalized.startsWith("patches/")
    || normalized.endsWith(".patch");
}

export function verifyProductionUnchanged(before, after) {
  for (const role of ["supervisor", "server", "web"]) {
    const prior = before.processes[role];
    const current = after.processes[role];
    if (!prior || !current || prior.pid !== current.pid || prior.cgroup !== current.cgroup) {
      throw new Error(`production ${role} identity changed`);
    }
  }
  const panes = new Map(after.tmuxPanes.map((pane) => [pane.identity, pane.pid]));
  for (const pane of before.tmuxPanes) {
    if (panes.get(pane.identity) !== pane.pid) throw new Error(`production tmux pane changed: ${pane.identity}`);
  }
  const services = new Map(after.appServerServices.map((service) => [service.unit, service]));
  for (const service of before.appServerServices) {
    const current = services.get(service.unit);
    if (!current || current.mainPid !== service.mainPid || current.activeState !== service.activeState) {
      throw new Error(`production app-server service changed: ${service.unit}`);
    }
  }
  const sessions = new Map(after.sessions.map((session) => [session.id, session]));
  for (const session of before.sessions) {
    const current = sessions.get(session.id);
    if (!current || current.codexSessionId !== session.codexSessionId || current.driverKind !== session.driverKind || current.tmuxPaneId !== session.tmuxPaneId || current.tmuxPid !== session.tmuxPid) {
      throw new Error(`production session identity changed: ${session.id}`);
    }
  }
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${root}`);
  return result.stdout.trim();
}
