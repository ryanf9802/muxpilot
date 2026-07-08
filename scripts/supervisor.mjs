import { rmSync } from "node:fs";
import {
  appendSupervisorLog,
  spawnService,
  supervisorConfig,
  writePid
} from "./lifecycle.mjs";

const mode = process.argv[2];
const { config, state } = supervisorConfig(mode);
const children = new Map();
const restartAttempts = new Map();
let shuttingDown = false;

writePid(state.supervisorPidPath);
appendSupervisorLog(state, `supervisor started for ${mode}`);

startChild("server", config.backendArgs);
startChild("web", config.webArgs);

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

function startChild(name, args) {
  if (shuttingDown) return;

  const child = spawnService(name, args, state);
  children.set(name, child);
  appendSupervisorLog(state, `${name} started with PID ${child.pid}`);

  child.on("error", (error) => {
    appendSupervisorLog(state, `${name} failed to start: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    children.delete(name);
    const pidPath = name === "server" ? state.serverPidPath : state.webPidPath;
    rmSync(pidPath, { force: true });
    appendSupervisorLog(state, `${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`);

    if (shuttingDown) return;

    const attempt = (restartAttempts.get(name) ?? 0) + 1;
    restartAttempts.set(name, attempt);
    const delayMs = Math.min(1000 * attempt, 5000);
    appendSupervisorLog(state, `restarting ${name} in ${delayMs}ms`);
    setTimeout(() => startChild(name, args), delayMs).unref();
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  appendSupervisorLog(state, `supervisor received ${signal}; stopping children`);

  for (const [name, child] of children) {
    appendSupervisorLog(state, `sending SIGTERM to ${name} PID ${child.pid}`);
    terminateChildGroup(child.pid, "SIGTERM");
  }

  await sleep(1500);

  for (const [name, child] of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    appendSupervisorLog(state, `sending SIGKILL to ${name} PID ${child.pid}`);
    terminateChildGroup(child.pid, "SIGKILL");
  }

  rmSync(state.supervisorPidPath, { force: true });
  rmSync(state.serverPidPath, { force: true });
  rmSync(state.webPidPath, { force: true });
  appendSupervisorLog(state, "supervisor stopped");
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function terminateChildGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (error?.code !== "ESRCH") appendSupervisorLog(state, `could not send ${signal} to process group ${pid}: ${error.message}`);
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") appendSupervisorLog(state, `could not send ${signal} to PID ${pid}: ${error.message}`);
  }
}
