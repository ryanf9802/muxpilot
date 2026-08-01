#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { configuration, localizeDependency, readStatus, worktreeExists } from "./local-workflow.mjs";

if (process.argv[2] !== "localize" || !process.argv[3]) {
  process.stderr.write("Usage: muxpilot-git-deps localize <relative-path>\n");
  process.exit(2);
}
try {
  const config = await configuration();
  const status = await readStatus(config);
  if (status?.state !== "worktree" || !(await worktreeExists(status.worktreePath))) throw new Error("No active task worktree");
  const dependency = config.dependencies.find((candidate) => candidate.relativePath === process.argv[3]);
  if (!dependency) throw new Error(`'${process.argv[3]}' is not a registered shared dependency path`);
  if (dependency.kind !== "node") {
    const path = await localizeDependency(config, status.worktreePath, process.argv[3]);
    process.stdout.write(`DEPENDENCY_PREPARED kind=${dependency.kind} path=${path} install=required\n`);
  } else {
    const path = await localizeNodeDependency(config, status.worktreePath, dependency.relativePath);
    process.stdout.write(`DEPENDENCY_LOCALIZED kind=node path=${path} install=frozen\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

async function localizeNodeDependency(config, worktree, relativePath) {
  const target = resolve(worktree, relativePath);
  const packageRoot = await findNodeInstallRoot(worktree, dirname(target));
  const manifestPath = join(packageRoot, "package.json");
  const lockPath = join(packageRoot, "pnpm-lock.yaml");
  const manifestBefore = await readFile(manifestPath, "utf8").catch(() => null);
  const lockBefore = await readFile(lockPath, "utf8").catch(() => null);
  if (!manifestBefore || !lockBefore) throw new Error(`Node dependency localization requires an exact package manager and lockfile governing '${relativePath}'`);
  const declared = JSON.parse(manifestBefore).packageManager;
  const match = typeof declared === "string" ? declared.match(/^pnpm@(\d+\.\d+\.\d+)(?:\+.+)?$/) : null;
  if (!match) throw new Error("Node dependency localization requires an exact packageManager pin such as pnpm@10.30.3");
  const managed = config.dependencies.filter((candidate) => candidate.kind === "node" && resolve(worktree, candidate.relativePath).startsWith(`${packageRoot}/`));
  const swaps = [];
  for (const candidate of managed) {
    const path = resolve(worktree, candidate.relativePath);
    const info = await lstat(path).catch(() => null);
    if (!info?.isSymbolicLink()) continue;
    swaps.push({ path, backup: `${path}.muxpilot-shared-${process.pid}` });
  }
  if (!swaps.some((swap) => swap.path === target)) throw new Error(`'${relativePath}' is not a shared dependency symlink`);
  const cacheRoot = join(dirname(config.statusFile), "dependency-cache", encodeURIComponent(relativePath));
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const prepared = [];
  try {
    for (const swap of swaps) {
      await rename(swap.path, swap.backup);
      prepared.push(swap);
      await mkdir(swap.path, { recursive: true });
    }
    const runner = join(import.meta.dirname, "muxpilot-git-run.mjs");
    const environment = {
      ...process.env,
      COREPACK_HOME: join(cacheRoot, "corepack"),
      XDG_CACHE_HOME: join(cacheRoot, "xdg"),
      PNPM_HOME: join(cacheRoot, "pnpm-home"),
      npm_config_cache: join(cacheRoot, "npm"),
      PNPM_STORE_DIR: join(cacheRoot, "store")
    };
    const corepack = await findExecutable("corepack", environment.PATH);
    let packageCommand;
    let packageArguments;
    if (corepack) {
      packageCommand = corepack;
      packageArguments = [`pnpm@${match[1]}`, "install"];
    } else {
      const pnpm = await findExecutable("pnpm", environment.PATH);
      if (!pnpm || (await capture(pnpm, ["--version"], packageRoot, environment)).trim() !== match[1]) {
        throw new Error(`The pinned pnpm ${match[1]} is unavailable and corepack is not installed`);
      }
      packageCommand = pnpm;
      packageArguments = ["install"];
    }
    await run(process.execPath, [runner, "--heavy", "--", packageCommand, ...packageArguments, "--frozen-lockfile", "--store-dir", environment.PNPM_STORE_DIR], packageRoot, environment);
    if (await readFile(manifestPath, "utf8") !== manifestBefore || await readFile(lockPath, "utf8") !== lockBefore) {
      throw new Error("Frozen dependency installation changed package.json or pnpm-lock.yaml");
    }
    for (const swap of swaps) await rm(swap.backup, { recursive: true, force: true });
    return target;
  } catch (error) {
    for (const swap of prepared.reverse()) {
      await rm(swap.path, { recursive: true, force: true });
      await rename(swap.backup, swap.path);
    }
    throw error;
  }
}

async function findExecutable(name, pathValue) {
  for (const directory of String(pathValue ?? "").split(":")) {
    const candidate = join(directory, name);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

function capture(command, args, cwd, env) {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveCapture(stdout) : reject(new Error(stderr.trim() || `Package-manager probe exited ${code}`)));
  });
}

async function findNodeInstallRoot(worktree, start) {
  const root = resolve(worktree);
  let cursor = resolve(start);
  while (cursor === root || cursor.startsWith(`${root}/`)) {
    const manifest = await readFile(join(cursor, "package.json"), "utf8").catch(() => null);
    const lock = await readFile(join(cursor, "pnpm-lock.yaml"), "utf8").catch(() => null);
    if (manifest && lock && typeof JSON.parse(manifest).packageManager === "string") return cursor;
    if (cursor === root) break;
    cursor = dirname(cursor);
  }
  throw new Error(`No pinned Node install root governs '${start}'`);
}

function run(command, args, cwd, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Managed dependency install failed (${signal ?? `exit ${code}`})`)));
  });
}
