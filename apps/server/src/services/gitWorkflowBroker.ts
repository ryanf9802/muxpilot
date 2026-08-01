import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AppDatabase, StoredGitWorkspace } from "../db/database.js";
import { nowIso } from "../utils/time.js";
import { statusPath } from "./gitWorkspaceManager.js";

const execFileAsync = promisify(execFile);
const MAX_REQUEST_BYTES = 64 * 1024;

interface Logger {
  info(values: object, message: string): void;
  warn(values: object, message: string): void;
}

interface FinishRequest {
  action: "finish";
  workspaceId: string;
  token: string;
  targetSha: string;
  taskHead: string;
  cleanTargetBypass?: boolean;
  retainWorktree?: boolean;
}

export class GitWorkflowBroker {
  private server: Server | null = null;
  private queue = Promise.resolve();

  constructor(
    private readonly db: AppDatabase,
    private readonly socketPath: string,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true });
    await rm(this.socketPath, { force: true });
    this.server = createServer((socket) => {
      let input = "";
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        if (handled) return;
        input += chunk;
        if (input.length > MAX_REQUEST_BYTES) { handled = true; socket.destroy(new Error("request too large")); return; }
        if (!input.includes("\n")) return;
        handled = true;
        const operation = this.queue.then(() => this.handle(input.trim()));
        this.queue = operation.then(() => undefined, () => undefined);
        void operation.then(
          (response) => socket.end(`${JSON.stringify(response)}\n`),
          (error) => socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
        );
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolveListen);
    });
    await chmod(this.socketPath, 0o600);
    for (const workspace of await this.db.listGitWorkspaces()) await this.publishCapability(workspace);
    this.logger.info({ socketPath: this.socketPath }, "Git workflow broker started");
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
    await rm(this.socketPath, { force: true });
  }

  async publishCapability(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    if (!workspace.controlPath || !workspace.implementationRoot) return workspace;
    const persisted = await this.db.getGitWorkspace(workspace.id);
    const source = persisted ?? workspace;
    const controlPath = source.controlPath ?? workspace.controlPath;
    const token = source.helperToken || randomBytes(32).toString("hex");
    const next = token === source.helperToken ? source : { ...source, helperToken: token, updatedAt: nowIso() };
    if (next !== source) await this.db.upsertGitWorkspace(next, next.updatedAt);
    await mkdir(controlPath, { recursive: true });
    const path = join(controlPath, "git-workflow-broker.json");
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, workspaceId: next.id, socketPath: this.socketPath, token })}\n`, { mode: 0o600 });
    await rename(temporary, path);
    return next;
  }

  private async handle(raw: string): Promise<object> {
    const request = JSON.parse(raw) as Partial<FinishRequest>;
    if (request.action !== "finish" || typeof request.workspaceId !== "string" || typeof request.token !== "string"
      || typeof request.targetSha !== "string" || typeof request.taskHead !== "string"
      || (request.cleanTargetBypass !== undefined && typeof request.cleanTargetBypass !== "boolean")
      || (request.retainWorktree !== undefined && typeof request.retainWorktree !== "boolean")) throw new Error("invalid broker request");
    const workspace = await this.db.getGitWorkspace(request.workspaceId);
    if (!workspace || !workspace.helperToken || !timingSafeToken(workspace.helperToken, request.token)) throw new Error("unauthorized broker request");
    return this.finish(workspace, request as FinishRequest);
  }

  private async finish(workspace: StoredGitWorkspace, request: FinishRequest): Promise<object> {
    const status = JSON.parse(await readFile(statusPath(workspace), "utf8")) as Record<string, unknown>;
    const worktree = typeof status.worktreePath === "string" ? resolve(status.worktreePath) : "";
    const branch = typeof status.sessionBranch === "string" ? status.sessionBranch : "";
    const targetBranch = typeof status.targetBranch === "string" ? status.targetBranch : "";
    if (!["worktree", "integrating", "failed"].includes(String(status.state))) throw new Error("No active task worktree to integrate");
    if (!workspace.implementationRoot || !inside(resolve(workspace.implementationRoot), worktree)) throw new Error("Task worktree is outside the managed implementation root");
    if (!branch.startsWith(`muxpilot/${workspace.id}/`)) throw new Error("Task branch is not owned by this workspace");
    const targetRef = `refs/heads/${targetBranch}`;
    await git(workspace.summary.repoRoot, ["check-ref-format", "--branch", targetBranch]);
    if (await git(worktree, ["status", "--porcelain"])) throw new Error("The task worktree is not clean");
    const taskHead = await git(worktree, ["rev-parse", "HEAD"]);
    if (taskHead !== request.taskHead) throw new Error("Task head changed after helper preflight");
    const commonGitDir = workspace.commonGitDir || resolve(workspace.summary.repoRoot, await git(workspace.summary.repoRoot, ["rev-parse", "--git-common-dir"]));
    const release = await acquireDirectoryLock(join(commonGitDir, "muxpilot-locks", encodeURIComponent(targetBranch)));
    try {
      const targetHead = await git(workspace.summary.repoRoot, ["rev-parse", `${targetRef}^{commit}`]);
      if (targetHead !== request.targetSha) return { ok: false, reviewRequired: true, error: "Target advanced after helper preflight" };
      if (!await isAncestor(worktree, targetHead, taskHead)) return { ok: false, reviewRequired: true, error: "Task is no longer a fast-forward of the target" };
      const checkout = await targetCheckout(workspace.summary.repoRoot, targetRef);
      if (checkout && !request.cleanTargetBypass && await git(checkout, ["status", "--porcelain"])) throw new Error("DIRTY_TARGET: target changed during integration");
      await writeStatusFile(workspace, status, { state: "integrating", targetSha: targetHead, lastError: null });
      if (checkout) await git(checkout, ["merge", "--ff-only", taskHead]);
      else await git(workspace.summary.repoRoot, ["update-ref", targetRef, taskHead, targetHead]);
    } finally {
      await release();
    }
    if (!request.retainWorktree) await cleanup(workspace, worktree, branch, taskHead);
    await writeStatusFile(workspace, status, {
      state: "idle", targetSha: taskHead, lastError: null,
      sessionBranch: request.retainWorktree ? branch : null,
      worktreePath: request.retainWorktree ? worktree : null
    });
    return { ok: true, sha: taskHead, retained: Boolean(request.retainWorktree) };
  }
}

async function cleanup(workspace: StoredGitWorkspace, worktree: string, branch: string, taskHead: string): Promise<void> {
  const branchRef = `refs/heads/${branch}`;
  if (await git(workspace.summary.repoRoot, ["rev-parse", `${branchRef}^{commit}`]) !== taskHead) throw new Error("Temporary branch moved during cleanup");
  for (const dependency of workspace.summary.dependencyLinks) {
    const path = resolve(worktree, dependency.relativePath);
    if (!inside(worktree, path)) throw new Error("Dependency cleanup path escapes the worktree");
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) await unlink(path); else if (info) await rm(path, { recursive: true, force: true });
  }
  await git(workspace.summary.repoRoot, ["worktree", "remove", worktree]);
  await git(workspace.summary.repoRoot, ["update-ref", "-d", branchRef, taskHead]);
}

async function writeStatusFile(workspace: StoredGitWorkspace, previous: Record<string, unknown>, changes: Record<string, unknown>): Promise<void> {
  const path = statusPath(workspace);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...previous, ...changes, updatedAt: nowIso() }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function targetCheckout(repoRoot: string, targetRef: string): Promise<string | null> {
  for (const block of (await git(repoRoot, ["worktree", "list", "--porcelain"])).split(/\n\n+/)) {
    const lines = block.split("\n");
    if (lines.includes(`branch ${targetRef}`)) return lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? null;
  }
  return null;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try { await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    throw new Error(detail.stderr?.trim() || detail.message);
  }
}

function inside(root: string, path: string): boolean { return path === root || path.startsWith(`${root}${sep}`); }
function timingSafeToken(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
}

async function acquireDirectoryLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(path);
      await writeFile(join(path, "owner"), `${process.pid}\n${nowIso()}\n`);
      return () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await staleLock(path)) { await rm(path, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for another task to integrate into the target branch");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
}

async function staleLock(path: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(join(path, "owner"), "utf8")).split(/\r?\n/)[0]);
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch {
    const details = await stat(path).catch(() => null);
    return Boolean(details && Date.now() - details.mtimeMs > 10_000);
  }
}
