import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitDependencyLink, GitRepositoryProbe, GitWorkspaceSummary } from "@muxpilot/core";
import type { AppDatabase, StoredGitWorkspace } from "../db/database.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";

const execFileAsync = promisify(execFile);

export interface LightweightGitWorkspaceOptions {
  worktreeRoot: string;
  sessionRoot: string;
}

interface ProvisionRequest {
  sessionName: string;
  entryPath: string;
  targetBranch: string;
}

interface StatusFile {
  version: 1;
  state: GitWorkspaceSummary["state"];
  targetBranch: string;
  targetSha: string;
  sessionBranch: string | null;
  worktreePath: string | null;
  lastError: string | null;
  updatedAt: string;
}

/**
 * Session metadata and read-only status observation only. Worktree creation,
 * review, integration, and cleanup belong entirely to the bundled skill.
 */
export class GitWorkspaceManager {
  constructor(
    private readonly db: AppDatabase,
    private readonly options: LightweightGitWorkspaceOptions
  ) {}

  async probe(entryPath: string): Promise<GitRepositoryProbe> {
    const path = await realpath(entryPath);
    try {
      const bare = (await git(path, ["rev-parse", "--is-bare-repository"])) === "true";
      const repoRoot = bare ? path : await git(path, ["rev-parse", "--show-toplevel"]);
      const currentBranch = bare ? null : (await git(repoRoot, ["branch", "--show-current"])) || null;
      const dirty = bare ? false : Boolean(await git(repoRoot, ["status", "--porcelain"]));
      const localBranches = lines(await git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]));
      return {
        isGit: true,
        bare,
        incompatibleReason: bare ? "Bare repositories cannot host interactive muxpilot sessions" : null,
        repoRoot,
        repoName: basename(repoRoot),
        currentBranch,
        dirty,
        localBranches
      };
    } catch {
      return {
        isGit: false,
        bare: false,
        incompatibleReason: null,
        repoRoot: null,
        repoName: basename(path),
        currentBranch: null,
        dirty: false,
        localBranches: []
      };
    }
  }

  async provision(request: ProvisionRequest): Promise<StoredGitWorkspace> {
    const probe = await this.probe(request.entryPath);
    if (!probe.isGit || !probe.repoRoot) throw new GitWorkspaceError("Directory is not in a Git repository", "not_git");
    if (probe.bare) throw new GitWorkspaceError(probe.incompatibleReason ?? "Bare repositories are unsupported", "bare_repository");
    if (!probe.localBranches.includes(request.targetBranch)) {
      throw new GitWorkspaceError(`Local target branch '${request.targetBranch}' does not exist`, "missing_local_branch");
    }
    const id = eventId();
    const controlPath = join(this.options.sessionRoot, id);
    const implementationRoot = join(this.options.worktreeRoot, id);
    await Promise.all([mkdir(controlPath, { recursive: true }), mkdir(implementationRoot, { recursive: true })]);
    const commonGitDir = resolve(probe.repoRoot, await git(probe.repoRoot, ["rev-parse", "--git-common-dir"]));
    const targetSha = await git(probe.repoRoot, ["rev-parse", `refs/heads/${request.targetBranch}^{commit}`]);
    const dependencyLinks = await discoverDependencies(probe.repoRoot);
    const createdAt = nowIso();
    const summary: GitWorkspaceSummary = {
      workflowVersion: 1,
      id,
      state: "idle",
      entryPath: await realpath(request.entryPath),
      repoRoot: probe.repoRoot,
      targetBranch: request.targetBranch,
      targetSha,
      sessionBranch: null,
      worktreePath: null,
      lastError: null,
      updatedAt: createdAt,
      dependencyLinks
    };
    const stored: StoredGitWorkspace = {
      id,
      sessionId: null,
      sessionName: request.sessionName,
      commonGitDir,
      targetRef: `refs/heads/${request.targetBranch}`,
      controlPath,
      implementationRoot,
      recoveryRef: null,
      helperToken: "",
      summary,
      createdAt,
      updatedAt: createdAt
    };
    await this.db.upsertGitWorkspace(stored, createdAt);
    return stored;
  }

  async bind(workspaceId: string, sessionId: string): Promise<StoredGitWorkspace> {
    await this.db.bindGitWorkspace(workspaceId, sessionId, nowIso());
    return requireWorkspace(await this.db.getGitWorkspace(workspaceId));
  }

  getBySession(sessionId: string): Promise<StoredGitWorkspace | null> {
    return this.db.getGitWorkspaceBySession(sessionId);
  }

  get(workspaceId: string): Promise<StoredGitWorkspace | null> {
    return this.db.getGitWorkspace(workspaceId);
  }

  async ensureControlPath(workspace: StoredGitWorkspace): Promise<string> {
    const path = workspace.controlPath ?? join(this.options.sessionRoot, workspace.id);
    await mkdir(path, { recursive: true });
    return path;
  }

  async refresh(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    const previous = workspace.summary as GitWorkspaceSummary & { workflowVersion?: number };
    const legacy = previous.workflowVersion !== 1;
    let observed: StatusFile | null = null;
    try {
      const raw = await readFile(statusPath(workspace), "utf8");
      const status = JSON.parse(raw) as Partial<StatusFile>;
      if (validStatus(status, previous.targetBranch)) observed = status;
    } catch {
      // Status is observational. Missing, malformed, or unreadable files fall
      // back to local Git/worktree state instead of becoming UI errors.
    }
    const survivingWorktree = !observed && await activeWorktree(previous);
    const targetSha = await git(previous.repoRoot, ["rev-parse", `refs/heads/${previous.targetBranch}^{commit}`]).catch(() => null);
    const missingCurrentTarget = !targetSha && !legacy;
    const state = missingCurrentTarget
      ? "failed"
      : observed?.state ?? (survivingWorktree ? "worktree" : "idle");
    const summary: GitWorkspaceSummary = {
      workflowVersion: 1,
      id: previous.id,
      state,
      entryPath: previous.entryPath,
      repoRoot: previous.repoRoot,
      targetBranch: previous.targetBranch,
      targetSha: targetSha ?? previous.targetSha ?? "",
      sessionBranch: observed?.sessionBranch ?? (survivingWorktree ? previous.sessionBranch : null),
      worktreePath: observed?.worktreePath ?? (survivingWorktree ? previous.worktreePath : null),
      lastError: missingCurrentTarget
        ? `Local target branch '${previous.targetBranch}' no longer exists`
        : observed && ["blocked", "failed"].includes(observed.state) ? observed.lastError : null,
      updatedAt: observed?.updatedAt ?? (legacy ? "" : workspace.updatedAt),
      dependencyLinks: Array.isArray(previous.dependencyLinks) ? previous.dependencyLinks : []
    };
    const next = { ...workspace, summary };
    if (JSON.stringify(next.summary) !== JSON.stringify(workspace.summary)) await this.db.upsertGitWorkspace(next, nowIso());
    return next;
  }

}

async function activeWorktree(summary: GitWorkspaceSummary & { workflowVersion?: number }): Promise<boolean> {
  if (!summary.worktreePath || !summary.sessionBranch || !(await isDirectory(summary.worktreePath))) return false;
  const branch = await git(summary.worktreePath, ["branch", "--show-current"]).catch(() => "");
  return branch === summary.sessionBranch;
}

export class GitWorkspaceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export function statusPath(workspace: StoredGitWorkspace): string {
  return join(workspace.controlPath ?? workspace.summary.entryPath, "git-workflow-status.json");
}

async function discoverDependencies(repoRoot: string): Promise<GitDependencyLink[]> {
  const manifests = lines(await git(repoRoot, [
    "ls-files", "--", "package.json", "**/package.json", "pyproject.toml", "**/pyproject.toml",
    "setup.py", "**/setup.py", "requirements*.txt", "**/requirements*.txt", "Pipfile", "**/Pipfile",
    "composer.json", "**/composer.json", "Gemfile", "**/Gemfile"
  ]));
  const candidates = new Map<string, GitDependencyLink["kind"]>();
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
  const links: GitDependencyLink[] = [];
  for (const [relativePath, kind] of candidates) {
    const sourcePath = join(repoRoot, relativePath);
    if (!(await isDirectory(sourcePath))) continue;
    if (await git(repoRoot, ["ls-files", "--", relativePath])) continue;
    links.push({ kind, relativePath, sourcePath: await realpath(sourcePath), linked: true });
  }
  return links;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isDirectory()).catch(() => false);
}

function validStatus(status: Partial<StatusFile>, targetBranch: string): status is StatusFile {
  return status.version === 1
    && status.targetBranch === targetBranch
    && ["idle", "worktree", "integrating", "blocked", "failed"].includes(String(status.state))
    && typeof status.targetSha === "string"
    && typeof status.updatedAt === "string"
    && (status.sessionBranch === null || typeof status.sessionBranch === "string")
    && (status.worktreePath === null || typeof status.worktreePath === "string")
    && (status.lastError === null || typeof status.lastError === "string");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function requireWorkspace(workspace: StoredGitWorkspace | null): StoredGitWorkspace {
  if (!workspace) throw new GitWorkspaceError("Git workspace not found", "missing_workspace");
  return workspace;
}
