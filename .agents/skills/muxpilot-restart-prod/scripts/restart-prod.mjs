#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostScopedHeavyEnvironment,
  isMuxpilotSessionCgroup,
  isRestartExecutionCgroup,
  restartScopeUnitName
} from "./restart-environment.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: restart-prod.mjs --expected-commit <sha> [--preflight]");
  process.exit(0);
}

const expectedCommit = optionValue(args, "--expected-commit");
if (!expectedCommit) fail("--expected-commit is required");

const repoRoot = git(["rev-parse", "--show-toplevel"]);
const head = git(["rev-parse", "HEAD"]);
if (head !== expectedCommit) fail(`expected commit ${expectedCommit}, but checkout is at ${head}`);
if (git(["status", "--porcelain"])) fail("target checkout is dirty");

const ownCgroup = readCgroup("self");
if (!isRestartExecutionCgroup(ownCgroup)) {
  if (args.includes("--scoped-relaunch")) {
    fail(`systemd relaunch remained in ${ownCgroup}; a non-session user scope is required`);
  }
  relaunchInHostScope();
}

const helperDir = process.env.MUXPILOT_GIT_HELPER_DIR
  ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills", "muxpilot-git-workflow", "scripts");
const heavyRunner = join(helperDir, "muxpilot-git-run.mjs");
if (!existsSync(heavyRunner)) fail(`heavy command runner not found at ${heavyRunner}`);

if (args.includes("--preflight")) {
  console.log(`MUXPILOT_PROD_RESTART_PREFLIGHT_OK commit=${head} cgroup=${ownCgroup}`);
  process.exit(0);
}

const restart = spawnSync(process.execPath, [heavyRunner, "--heavy", "--", "pnpm", "app", "restart", "prod"], {
  cwd: repoRoot,
  // Keep the scheduler wait and the restart attached to this host-scoped verifier.
  // A deferred continuation would resume inside the requesting Codex session and
  // skip the commit, health, PID, and cgroup checks below.
  env: hostScopedHeavyEnvironment(process.env),
  stdio: "inherit"
});
if (restart.error) fail(`restart failed: ${restart.error.message}`);
if (restart.status !== 0) fail(`restart exited with status ${restart.status ?? "unknown"}`);

const status = spawnSync("pnpm", ["app", "status", "prod"], { cwd: repoRoot, env: process.env, stdio: "inherit" });
if (status.error || status.status !== 0) fail("production status check failed");

const runtimeDir = resolve(repoRoot, "data", "runtime", "prod");
const verified = Object.fromEntries(["supervisor", "server", "web"].map((role) => {
  const pid = readPid(join(runtimeDir, `${role}.pid`), role);
  process.kill(pid, 0);
  const cgroup = readCgroup(pid);
  if (isMuxpilotSessionCgroup(cgroup)) fail(`${role} PID ${pid} remained in muxpilot session cgroup ${cgroup}`);
  if (cgroup !== ownCgroup) fail(`${role} PID ${pid} is in ${cgroup}, not restart cgroup ${ownCgroup}`);
  return [role, pid];
}));

if (git(["rev-parse", "HEAD"]) !== expectedCommit) fail("checkout commit changed during restart");
console.log(
  `MUXPILOT_PROD_RESTARTED_OUTSIDE_SESSION_SCOPE commit=${expectedCommit} supervisor=${verified.supervisor} server=${verified.server} web=${verified.web} cgroup=${ownCgroup}`
);

function relaunchInHostScope() {
  const unit = restartScopeUnitName(process.pid, randomBytes(4).toString("hex"));
  const childArgs = args.filter((arg) => arg !== "--scoped-relaunch");
  childArgs.push("--scoped-relaunch");
  const relaunched = spawnSync("systemd-run", [
    "--user", "--scope", "--quiet", "--collect", `--unit=${unit}`,
    process.execPath, fileURLToPath(import.meta.url), ...childArgs
  ], { cwd: repoRoot, env: process.env, stdio: "inherit" });
  if (relaunched.error) fail(`could not enter host restart scope: ${relaunched.error.message}; use host/elevated execution`);
  if (relaunched.status !== 0) fail(`host restart scope exited with status ${relaunched.status ?? "unknown"}`);
  process.exit(0);
}

function optionValue(values, name) {
  const index = values.indexOf(name);
  return index === -1 ? null : values[index + 1] ?? null;
}

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`git ${gitArgs.join(" ")} failed`);
  return result.stdout.trim();
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
  console.error(`muxpilot restart refused: ${message}`);
  process.exit(1);
}
