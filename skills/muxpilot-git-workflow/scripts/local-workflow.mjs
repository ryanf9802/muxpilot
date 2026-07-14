import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function configuration() {
  const config = {
    workspaceId: process.env.MUXPILOT_GIT_WORKSPACE_ID,
    repoRoot: process.env.MUXPILOT_GIT_REPO_ROOT,
    targetBranch: await currentTargetBranch(
      process.env.MUXPILOT_GIT_STATUS_FILE,
      process.env.MUXPILOT_GIT_TARGET_BRANCH
    ),
    worktreeRoot: process.env.MUXPILOT_GIT_WORKTREE_ROOT,
    statusFile: process.env.MUXPILOT_GIT_STATUS_FILE,
    dependencies: parseDependencies(process.env.MUXPILOT_GIT_DEPENDENCIES)
  };
  for (const [key, value] of Object.entries(config)) {
    if (key !== "dependencies" && !value) throw new Error(`Missing muxpilot Git configuration: ${key}`);
  }
  return config;
}

export async function git(cwd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    return options.result ? { stdout: stdout.trim(), stderr: stderr.trim() } : stdout.trim();
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || "Git command failed";
    throw new Error(detail);
  }
}

export async function readStatus(config) {
  try {
    const value = JSON.parse(await readFile(config.statusFile, "utf8"));
    return value?.version === 1 && value?.targetBranch === config.targetBranch ? value : null;
  } catch {
    return null;
  }
}

export async function writeStatus(config, value) {
  const status = {
    version: 1,
    state: value.state,
    targetBranch: config.targetBranch,
    targetSha: value.targetSha,
    sessionBranch: value.sessionBranch ?? null,
    worktreePath: value.worktreePath ?? null,
    lastError: value.lastError ?? null,
    reviewRequired: value.reviewRequired === true,
    updatedAt: new Date().toISOString()
  };
  await mkdir(dirname(config.statusFile), { recursive: true });
  const temporary = `${config.statusFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(temporary, config.statusFile);
  return status;
}

export async function linkDependencies(config, worktreePath) {
  const linked = [];
  for (const dependency of config.dependencies) {
    const target = safeJoin(worktreePath, dependency.relativePath);
    try {
      await lstat(target);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    await symlink(dependency.sourcePath, target, "dir");
    linked.push(dependency);
  }
  return linked;
}

export async function ignoreSharedDependencies(config, worktreePath) {
  if (config.dependencies.length === 0) return;
  const inheritedExcludeFile = await git(worktreePath, ["config", "--path", "--get", "core.excludesFile"]).catch(() => null);
  const inheritedPatterns = inheritedExcludeFile
    ? await readFile(inheritedExcludeFile, "utf8").catch(() => "")
    : "";
  await git(config.repoRoot, ["config", "extensions.worktreeConfig", "true"]);
  const gitDirectory = await git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
  const excludeFile = join(gitDirectory, "muxpilot-dependencies.exclude");
  const patterns = config.dependencies.map((dependency) => `/${escapeIgnorePattern(dependency.relativePath.replaceAll("\\", "/"))}`);
  const prefix = inheritedPatterns === "" || inheritedPatterns.endsWith("\n") ? inheritedPatterns : `${inheritedPatterns}\n`;
  await writeFile(excludeFile, `${prefix}${patterns.join("\n")}\n`, "utf8");
  await git(worktreePath, ["config", "--worktree", "core.excludesFile", excludeFile]);
}

export async function localizeDependency(config, worktreePath, relativePath) {
  const dependency = config.dependencies.find((candidate) => candidate.relativePath === relativePath);
  if (!dependency) throw new Error(`'${relativePath}' is not a registered shared dependency path`);
  const target = safeJoin(worktreePath, relativePath);
  const info = await lstat(target).catch(() => null);
  if (!info?.isSymbolicLink()) throw new Error(`'${relativePath}' is not a shared dependency symlink`);
  await unlink(target);
  await mkdir(target, { recursive: true });
  return target;
}

export async function unlinkSharedDependencies(config, worktreePath) {
  for (const dependency of config.dependencies) {
    const target = safeJoin(worktreePath, dependency.relativePath);
    const info = await lstat(target).catch(() => null);
    if (info?.isSymbolicLink()) await unlink(target);
    else if (info) await rm(target, { recursive: true, force: true });
  }
}

export async function worktreeExists(path) {
  if (!path) return false;
  return lstat(path).then((value) => value.isDirectory()).catch(() => false);
}

export async function acquireBranchLock(config) {
  const commonDir = resolve(config.repoRoot, await git(config.repoRoot, ["rev-parse", "--git-common-dir"]));
  const lock = join(commonDir, "muxpilot-locks", encodeURIComponent(config.targetBranch));
  return acquireDirectoryLock(lock, "Timed out waiting for another task to integrate into the target branch");
}

export async function acquireWorkspaceLock(statusFile = process.env.MUXPILOT_GIT_STATUS_FILE) {
  if (!statusFile) throw new Error("Missing muxpilot Git configuration: statusFile");
  return acquireDirectoryLock(join(dirname(statusFile), "git-workflow-operation.lock"), "Timed out waiting for another workflow operation in this session");
}

async function acquireDirectoryLock(lock, timeoutMessage) {
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner"), `${process.pid}\n${new Date().toISOString()}\n`);
      return async () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await staleLock(lock)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

async function currentTargetBranch(statusFile, fallback) {
  if (!statusFile) return fallback;
  try {
    const status = JSON.parse(await readFile(statusFile, "utf8"));
    if (status?.version === 1 && typeof status.targetBranch === "string" && status.targetBranch !== "") {
      return status.targetBranch;
    }
  } catch {
    // The launch-time target remains the fallback until valid workflow status exists.
  }
  return fallback;
}

async function staleLock(lock) {
  try {
    const owner = await readFile(join(lock, "owner"), "utf8");
    const pid = Number(owner.split(/\r?\n/)[0]);
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch {
    const info = await stat(lock).catch(() => null);
    return Boolean(info && Date.now() - info.mtimeMs > 10_000);
  }
}

export async function targetCheckout(config) {
  const output = await git(config.repoRoot, ["worktree", "list", "--porcelain"]);
  let path = null;
  for (const block of output.split(/\n\n+/)) {
    const lines = block.split("\n");
    const candidate = lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? null;
    const branch = lines.find((line) => line.startsWith("branch "))?.slice(7) ?? null;
    if (branch === `refs/heads/${config.targetBranch}`) path = candidate;
  }
  return path;
}

function parseDependencies(raw) {
  try {
    const values = JSON.parse(raw || "[]");
    return Array.isArray(values)
      ? values.filter((value) => value && safeRelative(value.relativePath) && typeof value.sourcePath === "string")
      : [];
  } catch {
    return [];
  }
}

function safeRelative(value) {
  return typeof value === "string" && value !== "" && !value.startsWith("/") && !value.split(/[\\/]+/).includes("..");
}

function safeJoin(root, relativePath) {
  if (!safeRelative(relativePath)) throw new Error(`Unsafe dependency path: ${relativePath}`);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${resolve(root)}/`)) throw new Error(`Dependency path escapes the worktree: ${relativePath}`);
  return path;
}

function escapeIgnorePattern(path) {
  return path.replace(/[\\*?[\] #!]/g, "\\$&");
}
