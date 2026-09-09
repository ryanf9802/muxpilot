import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createConnection } from "node:net";

const execFileAsync = promisify(execFile);
const MANAGED_CONFIG_KEYS = [
  "MUXPILOT_GIT_WORKSPACE_ID",
  "MUXPILOT_GIT_REPO_ROOT",
  "MUXPILOT_GIT_TARGET_BRANCH",
  "MUXPILOT_GIT_WORKTREE_ROOT",
  "MUXPILOT_GIT_STATUS_FILE"
];

export async function configuration() {
  const managedValues = MANAGED_CONFIG_KEYS.map((key) => process.env[key]);
  const managedCount = managedValues.filter(Boolean).length;
  if (managedCount > 0 && managedCount < MANAGED_CONFIG_KEYS.length) {
    const missing = MANAGED_CONFIG_KEYS.filter((key) => !process.env[key]);
    throw new Error(`Incomplete managed muxpilot Git configuration; missing ${missing.join(", ")}`);
  }
  if (managedCount === 0) return standaloneConfiguration();

  const config = {
    executionMode: "managed",
    workspaceId: process.env.MUXPILOT_GIT_WORKSPACE_ID,
    entryPath: process.env.MUXPILOT_GIT_ENTRY_PATH ?? process.env.MUXPILOT_GIT_REPO_ROOT,
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

export async function initializeStandalone(entryPath, targetBranch) {
  const managedKeys = MANAGED_CONFIG_KEYS.filter((key) => process.env[key]);
  if (managedKeys.length > 0) throw new Error("This Codex process already has muxpilot Git configuration; standalone initialization is not allowed");
  const paths = await standalonePaths();
  const existing = await readStandaloneConfig(paths.configFile);
  const requestedEntry = await realpath(resolve(entryPath));
  const repoRoot = await realpath(await git(requestedEntry, ["rev-parse", "--show-toplevel"]));
  if (await git(repoRoot, ["rev-parse", "--is-bare-repository"]) === "true") throw new Error("Bare repositories are unsupported");
  await git(repoRoot, ["check-ref-format", "--branch", targetBranch]);
  await git(repoRoot, ["show-ref", "--verify", `refs/heads/${targetBranch}`]);
  const targetSha = await git(repoRoot, ["rev-parse", `refs/heads/${targetBranch}^{commit}`]);

  if (existing) {
    if (existing.workspaceId !== `standalone-${paths.identity}` || existing.statusFile !== paths.statusFile || existing.worktreeRoot !== paths.worktreeRoot) {
      throw new Error("Standalone Git workflow configuration does not belong to the current Codex session");
    }
    const currentTarget = await currentTargetBranch(existing.statusFile, existing.targetBranch);
    if (existing.repoRoot !== repoRoot || existing.entryPath !== requestedEntry) {
      throw new Error(`This Codex session is already initialized for ${existing.entryPath}; use a new Codex session for another repository`);
    }
    if (currentTarget !== targetBranch) {
      throw new Error(`This standalone workflow already targets '${currentTarget}'; use muxpilot-git-target after fixed-target confirmation`);
    }
    return { ...existing, targetBranch: currentTarget, targetSha, reused: true };
  }

  const config = {
    version: 1,
    executionMode: "standalone",
    workspaceId: `standalone-${paths.identity}`,
    entryPath: requestedEntry,
    repoRoot,
    targetBranch,
    worktreeRoot: paths.worktreeRoot,
    statusFile: paths.statusFile,
    dependencies: await discoverDependencies(repoRoot)
  };
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  await chmod(paths.stateRoot, 0o700);
  await mkdir(paths.controlRoot, { mode: 0o700 });
  await chmod(paths.controlRoot, 0o700);
  await mkdir(paths.worktreeRoot, { recursive: true, mode: 0o700 });
  const temporary = `${paths.configFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, paths.configFile);
  await chmod(paths.configFile, 0o600);
  await writeStatus(config, { state: "idle", targetSha, sessionBranch: null, worktreePath: null, lastError: null });
  return { ...config, targetSha, reused: false };
}

export async function standaloneConfiguration() {
  const paths = await standalonePaths();
  const stored = await readStandaloneConfig(paths.configFile);
  if (!stored) {
    throw new Error("Standalone Git workflow is not initialized for this Codex session. Obtain user approval for an explicit local target, then run muxpilot-git-init.mjs <entry-path> <target-branch> --confirm-target");
  }
  if (stored.workspaceId !== `standalone-${paths.identity}` || stored.statusFile !== paths.statusFile || stored.worktreeRoot !== paths.worktreeRoot) {
    throw new Error("Standalone Git workflow configuration does not belong to the current Codex session");
  }
  const targetBranch = await currentTargetBranch(stored.statusFile, stored.targetBranch);
  return { ...stored, targetBranch, executionMode: "standalone" };
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
    executionMode: config.executionMode ?? "managed",
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

export function writeGitWorkflowEvent(kind, operation, config, details = {}) {
  if (!config?.workspaceId || !config?.targetBranch) return;
  const event = {
    version: 1,
    eventId: `mwf-${randomBytes(6).toString("hex")}`,
    kind,
    operation,
    workspaceId: config.workspaceId,
    targetBranch: config.targetBranch,
    skill: "$muxpilot-git-workflow",
    executionMode: config.executionMode ?? "managed",
    ...details
  };
  process.stdout.write(`<muxpilot_git_workflow>\n${JSON.stringify(event)}\n</muxpilot_git_workflow>\n`);
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

async function standalonePaths() {
  const identitySource = process.env.MUXPILOT_GIT_STANDALONE_ID
    ?? process.env.CODEX_SESSION_ID
    ?? process.env.CODEX_THREAD_ID;
  if (!identitySource) {
    throw new Error("Standalone Git workflow requires MUXPILOT_GIT_STANDALONE_ID, CODEX_SESSION_ID, or CODEX_THREAD_ID");
  }
  const identity = createHash("sha256").update(identitySource).digest("hex").slice(0, 16);
  const root = process.env.MUXPILOT_GIT_STANDALONE_ROOT ?? join(tmpdir(), `muxpilot-git-standalone-${process.getuid?.() ?? "user"}`);
  const controlRoot = join(root, identity);
  return {
    identity,
    stateRoot: root,
    controlRoot,
    configFile: join(controlRoot, "configuration.json"),
    statusFile: join(controlRoot, "git-workflow-status.json"),
    worktreeRoot: join(controlRoot, "worktrees")
  };
}

async function readStandaloneConfig(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.version !== 1 || value.executionMode !== "standalone") return null;
    const required = ["workspaceId", "entryPath", "repoRoot", "targetBranch", "worktreeRoot", "statusFile"];
    if (required.some((key) => typeof value[key] !== "string" || value[key] === "")) return null;
    return { ...value, dependencies: parseDependencies(JSON.stringify(value.dependencies ?? [])) };
  } catch {
    return null;
  }
}

async function discoverDependencies(repoRoot) {
  const manifests = lines(await git(repoRoot, [
    "ls-files", "--", "package.json", "**/package.json", "pyproject.toml", "**/pyproject.toml",
    "setup.py", "**/setup.py", "requirements*.txt", "**/requirements*.txt", "Pipfile", "**/Pipfile",
    "composer.json", "**/composer.json", "Gemfile", "**/Gemfile"
  ]));
  const candidates = new Map();
  for (const manifest of manifests) {
    const directory = dirname(manifest) === "." ? "" : dirname(manifest);
    const name = basename(manifest);
    if (name === "package.json") candidates.set(join(directory, "node_modules"), "node");
    else if (name === "composer.json") candidates.set(join(directory, "vendor"), "composer");
    else if (name === "Gemfile") candidates.set(join(directory, "vendor", "bundle"), "bundler");
    else {
      candidates.set(join(directory, ".venv"), "python");
      candidates.set(join(directory, "venv"), "python");
    }
  }
  const dependencies = [];
  for (const [relativePath, kind] of candidates) {
    const sourcePath = join(repoRoot, relativePath);
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (!await access(sourcePath, constants.W_OK).then(() => true).catch(() => false)) continue;
    if (await git(repoRoot, ["ls-files", "--", relativePath])) continue;
    dependencies.push({ kind, relativePath, sourcePath: await realpath(sourcePath), linked: true });
  }
  return dependencies;
}

async function gitLikeExec(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new Error(error?.stderr?.trim() || error?.message || `${command} failed`);
  }
}

function lines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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

export async function brokerFinish(config, request) {
  const capabilityPath = join(dirname(config.statusFile), "git-workflow-broker.json");
  let capability;
  try {
    capability = JSON.parse(await readFile(capabilityPath, "utf8"));
  } catch {
    return null;
  }
  if (capability?.version !== 1 || capability.workspaceId !== config.workspaceId
    || typeof capability.socketPath !== "string" || typeof capability.token !== "string") {
    throw new Error("Invalid muxpilot Git broker capability");
  }
  try {
    return await sendBroker(capability.socketPath, { action: "finish", workspaceId: config.workspaceId, token: capability.token, ...request });
  } catch (error) {
    throw new Error(`BROKER_UNAVAILABLE: ${error.message}`);
  }
}

function sendBroker(path, payload) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    let input = "";
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error("broker request timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      socket.end();
      try { resolvePromise(JSON.parse(input.trim())); } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
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
