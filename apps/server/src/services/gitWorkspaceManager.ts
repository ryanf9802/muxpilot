import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitInspection,
  GitRepositoryProbe,
  GitRevisionSpec,
  GitReviewSummary,
  GitWorkspaceAction,
  GitWorkspaceSummary
} from "@muxpilot/core";
import {
  GitWorkspaceCoordinator,
  GitWorkspaceError,
  type GitWorkspaceCoordinates,
  type ProvisionGitWorkspaceRequest
} from "@muxpilot/git-workspaces";
import type { AppDatabase, StoredGitWorkspace } from "../db/database.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";

const execFileAsync = promisify(execFile);

interface GitWorkspaceManagerOptions {
  worktreeRoot: string;
  inspectionRoot: string;
  integrationRoot: string;
}

export class GitWorkspaceManager {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: AppDatabase,
    private readonly coordinator: GitWorkspaceCoordinator,
    private readonly options: GitWorkspaceManagerOptions
  ) {}

  probe(path: string): Promise<GitRepositoryProbe> {
    return this.coordinator.probe(path);
  }

  async provision(request: Omit<ProvisionGitWorkspaceRequest, "workspaceId" | "worktreeRoot">): Promise<StoredGitWorkspace> {
    const id = eventId();
    const createdAt = nowIso();
    const provisioned = await this.coordinator.provision({
      ...request,
      workspaceId: id,
      worktreeRoot: this.options.worktreeRoot
    });
    const summary: GitWorkspaceSummary = {
      id,
      state: "active",
      entryPath: provisioned.entryPath,
      repoRoot: provisioned.repoRoot,
      targetBranch: provisioned.targetBranch,
      targetRemote: provisioned.targetRemote,
      targetSource: provisioned.targetSource,
      sourceSha: provisioned.sourceSha,
      sourceFetchedAt: provisioned.sourceFetchedAt,
      sourceFreshness: provisioned.sourceFreshness,
      targetSha: provisioned.targetSha,
      sessionBranch: provisioned.sessionBranch,
      sessionHeadSha: provisioned.sessionHeadSha,
      worktreePath: provisioned.worktreePath,
      dirty: false,
      aheadBy: 0,
      targetCheckedOutAt: null,
      review: null,
      reviewCurrent: false,
      inspections: [],
      remoteSha: null,
      remoteAheadBy: 0,
      remoteBehindBy: 0,
      lastError: provisioned.usedCachedRemote ? "Provisioned from an explicitly accepted cached remote revision" : null,
      cleanupEligible: false,
      compatibilityWarnings: provisioned.compatibilityWarnings
    };
    const stored: StoredGitWorkspace = {
      id,
      sessionId: null,
      commonGitDir: provisioned.commonGitDir,
      helperToken: randomBytes(24).toString("base64url"),
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

  async recover(): Promise<void> {
    for (const workspace of await this.db.listGitWorkspaces()) {
      if (workspace.summary.state === "cleaned") continue;
      try {
        await this.coordinator.recoverIntegrationWorktree(coordinates(workspace), this.options.integrationRoot);
        await this.refresh(workspace);
      } catch (error) {
        await this.save(workspace, { ...workspace.summary, lastError: errorMessage(error) });
      }
    }
  }

  async refresh(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    if (workspace.summary.state === "cleaned") return workspace;
    try {
      const status = await this.coordinator.status(coordinates(workspace));
      return await this.save(workspace, {
        ...workspace.summary,
        targetSha: status.targetSha,
        sessionHeadSha: status.sessionHeadSha,
        dirty: status.dirty,
        aheadBy: status.aheadBy,
        targetCheckedOutAt: status.targetCheckedOutAt,
        state: status.rebaseInProgress ? "integration_conflict" : recoverableState(workspace.summary.state),
        reviewCurrent:
          workspace.summary.review?.status === "passed" &&
          workspace.summary.review.targetSha === status.targetSha &&
          workspace.summary.review.headSha === status.sessionHeadSha,
        cleanupEligible:
          workspace.summary.state === "integrated" && !status.dirty && !status.rebaseInProgress && status.sessionHeadSha === status.targetSha,
        lastError: status.rebaseInProgress ? workspace.summary.lastError : null
      });
    } catch (error) {
      return this.save(workspace, { ...workspace.summary, state: "error", lastError: errorMessage(error) });
    }
  }

  async action(sessionId: string, action: GitWorkspaceAction): Promise<GitWorkspaceSummary> {
    const workspace = requireWorkspace(await this.db.getGitWorkspaceBySession(sessionId));
    const key = workspaceLockKey(workspace);
    if (action.type === "refresh") return (await this.refresh(workspace)).summary;
    if (action.type === "addInspection") return (await this.withLock(key, () => this.addInspection(workspace, action.revision, action.allowCachedRemote === true))).summary;
    if (action.type === "materializeInspection") return (await this.withLock(key, () => this.materializeInspection(workspace, action.inspectionId))).summary;
    if (action.type === "prepareReview") return (await this.prepareReview(workspace)).summary;
    if (action.type === "integrate") return (await this.withLock(key, () => this.integrate(workspace, action.bypassReview === true))).summary;
    if (action.type === "push") return (await this.withLock(key, () => this.push(workspace))).summary;
    if (action.type === "abortRebase") return (await this.withLock(key, () => this.abortRebase(workspace))).summary;
    return (await this.withLock(key, () => this.cleanup(workspace))).summary;
  }

  async addInspection(workspace: StoredGitWorkspace, revision: GitRevisionSpec, allowCachedRemote: boolean): Promise<StoredGitWorkspace> {
    const id = eventId();
    try {
      const resolved = await this.coordinator.addInspection(coordinates(workspace), id, revision, allowCachedRemote);
      const inspection: GitInspection = {
        id,
        requested: revision,
        resolvedRef: resolved.resolvedRef,
        commitSha: resolved.commitSha,
        worktreePath: null,
        fetchedAt: resolved.fetchedAt,
        freshness: resolved.freshness,
        error: null
      };
      return this.save(workspace, { ...workspace.summary, inspections: [...workspace.summary.inspections, inspection], lastError: null });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async addInspectionWithToken(workspaceId: string, token: string, revision: GitRevisionSpec): Promise<GitWorkspaceSummary> {
    const workspace = requireWorkspace(await this.db.getGitWorkspace(workspaceId));
    if (!validToken(workspace.helperToken, token)) throw new GitWorkspaceError("Invalid Git workspace capability", "invalid_capability");
    return (await this.withLock(`${workspace.commonGitDir}\0${workspace.summary.targetBranch}`, () => this.addInspection(workspace, revision, false))).summary;
  }

  private async materializeInspection(workspace: StoredGitWorkspace, inspectionId: string): Promise<StoredGitWorkspace> {
    const inspection = workspace.summary.inspections.find((candidate) => candidate.id === inspectionId);
    if (!inspection) throw new GitWorkspaceError("Inspection not found", "missing_inspection");
    if (inspection.worktreePath) return workspace;
    const worktreePath = await this.coordinator.materializeInspection(
      coordinates(workspace),
      inspection.id,
      inspection.commitSha,
      this.options.inspectionRoot
    );
    return this.save(workspace, {
      ...workspace.summary,
      inspections: workspace.summary.inspections.map((candidate) =>
        candidate.id === inspection.id ? { ...candidate, worktreePath } : candidate
      )
    });
  }

  private async prepareReview(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    let current = workspace;
    try {
      const prepared = await this.withLock(workspaceLockKey(workspace), () => this.coordinator.prepareIntegration(coordinates(workspace)));
      current = await this.save(workspace, {
        ...workspace.summary,
        state: "reviewing",
        targetSha: prepared.targetSha,
        sessionHeadSha: prepared.sessionHeadSha,
        dirty: prepared.dirty,
        aheadBy: prepared.aheadBy,
        targetCheckedOutAt: prepared.targetCheckedOutAt,
        review: null,
        reviewCurrent: false,
        lastError: null
      });
    } catch (error) {
      const conflict = error instanceof GitWorkspaceError && error.code === "integration_conflict";
      await this.save(workspace, {
        ...workspace.summary,
        state: conflict ? "integration_conflict" : "active",
        reviewCurrent: false,
        lastError: errorMessage(error)
      });
      throw normalizeError(error);
    }

    const review: GitReviewSummary = {
      id: eventId(),
      targetSha: current.summary.targetSha,
      headSha: current.summary.sessionHeadSha,
      status: "running",
      report: "",
      createdAt: nowIso(),
      completedAt: null
    };
    current = await this.save(current, { ...current.summary, review, state: "reviewing" });
    try {
      const prompt = reviewPrompt(current.summary);
      const { stdout, stderr } = await execFileAsync(
        "codex",
        codexReviewArgs(current.summary.worktreePath, current.summary.targetSha, prompt),
        { cwd: current.summary.worktreePath, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }
      );
      const completed = { ...review, status: "passed" as const, report: stdout.trim() || stderr.trim(), completedAt: nowIso() };
      return this.save(current, { ...current.summary, review: completed, reviewCurrent: true, state: "ready_to_integrate", lastError: null });
    } catch (error) {
      const failed = { ...review, status: "failed" as const, report: errorMessage(error), completedAt: nowIso() };
      return this.save(current, { ...current.summary, review: failed, reviewCurrent: false, state: "active", lastError: failed.report });
    }
  }

  private async integrate(workspace: StoredGitWorkspace, bypassReview: boolean): Promise<StoredGitWorkspace> {
    const current = await this.refresh(workspace);
    if (!bypassReview && !current.summary.reviewCurrent) {
      throw new GitWorkspaceError("A current review is required before integration", "review_required");
    }
    const integrating = await this.save(current, { ...current.summary, state: "integrating", lastError: null });
    try {
      const result = await this.coordinator.integrate(
        coordinates(integrating),
        this.options.integrationRoot,
        integrating.summary.targetSha,
        integrating.summary.sessionHeadSha
      );
      return this.save(integrating, {
        ...integrating.summary,
        state: result.cleanupPending ? "cleanup_pending" : "integrated",
        targetSha: result.targetSha,
        sessionHeadSha: result.targetSha,
        dirty: false,
        aheadBy: 0,
        cleanupEligible: true,
        lastError: result.cleanupPending ? "Integration succeeded, but its temporary worktree still needs cleanup" : null
      });
    } catch (error) {
      await this.save(integrating, { ...integrating.summary, state: "active", reviewCurrent: false, lastError: errorMessage(error) });
      throw normalizeError(error);
    }
  }

  private async push(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    if (!workspace.summary.cleanupEligible) throw new GitWorkspaceError("Integrate locally before pushing", "not_integrated");
    try {
      const pushed = await this.coordinator.push(coordinates(workspace));
      return this.save(workspace, {
        ...workspace.summary,
        remoteSha: pushed.remoteSha,
        remoteAheadBy: 0,
        remoteBehindBy: 0,
        lastError: null
      });
    } catch (error) {
      await this.save(workspace, { ...workspace.summary, lastError: errorMessage(error) });
      throw normalizeError(error);
    }
  }

  private async abortRebase(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    const status = await this.coordinator.abortRebase(coordinates(workspace));
    return this.save(workspace, {
      ...workspace.summary,
      state: "active",
      targetSha: status.targetSha,
      sessionHeadSha: status.sessionHeadSha,
      dirty: status.dirty,
      aheadBy: status.aheadBy,
      review: null,
      reviewCurrent: false,
      lastError: null
    });
  }

  private async cleanup(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    try {
      await this.coordinator.recoverIntegrationWorktree(coordinates(workspace), this.options.integrationRoot);
      await this.coordinator.cleanup(coordinates(workspace), workspace.summary.inspections);
      return this.save(workspace, {
        ...workspace.summary,
        state: "cleaned",
        cleanupEligible: false,
        lastError: null,
        inspections: workspace.summary.inspections.map((inspection) => ({ ...inspection, worktreePath: null }))
      });
    } catch (error) {
      await this.save(workspace, { ...workspace.summary, state: "cleanup_pending", lastError: errorMessage(error) });
      throw normalizeError(error);
    }
  }

  private async save(workspace: StoredGitWorkspace, summary: GitWorkspaceSummary): Promise<StoredGitWorkspace> {
    const updatedAt = nowIso();
    const next = { ...workspace, summary, updatedAt };
    await this.db.upsertGitWorkspace(next, updatedAt);
    return next;
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    const fileLock = await acquireFileLock(key);
    try {
      return await task();
    } finally {
      await fileLock.release();
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

function coordinates(workspace: StoredGitWorkspace): GitWorkspaceCoordinates {
  const summary = workspace.summary;
  return {
    workspaceId: workspace.id,
    repoRoot: summary.repoRoot,
    commonGitDir: workspace.commonGitDir,
    targetBranch: summary.targetBranch,
    targetRemote: summary.targetRemote,
    sourceSha: summary.sourceSha,
    targetSha: summary.targetSha,
    sessionBranch: summary.sessionBranch,
    worktreePath: summary.worktreePath
  };
}

function recoverableState(state: GitWorkspaceSummary["state"]): GitWorkspaceSummary["state"] {
  return ["integrated", "cleanup_pending", "cleaned"].includes(state) ? state : "active";
}

function requireWorkspace(workspace: StoredGitWorkspace | null): StoredGitWorkspace {
  if (!workspace) throw new GitWorkspaceError("Git workspace not found", "missing_workspace");
  return workspace;
}

function reviewPrompt(summary: GitWorkspaceSummary): string {
  const inspections = summary.inspections.map((inspection) => `${inspection.commitSha} (${revisionLabel(inspection.requested)})`).join(", ");
  return [
    `Review the committed changes from ${summary.targetSha} to ${summary.sessionHeadSha}.`,
    "Focus on correctness, regressions, missing tests, and operational risks. Do not edit files.",
    inspections ? `Relevant inspected revisions: ${inspections}.` : ""
  ].filter(Boolean).join(" ");
}

function revisionLabel(revision: GitRevisionSpec): string {
  if (revision.kind === "local_branch") return revision.branch;
  if (revision.kind === "remote_branch") return `${revision.remote}/${revision.branch}`;
  if (revision.kind === "local_tag") return revision.tag;
  if (revision.kind === "remote_tag") return `${revision.remote}/${revision.tag}`;
  return revision.oid;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  const value = error as Error & { stderr?: string };
  return value.stderr?.trim() || value.message || String(error);
}

function validToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function workspaceLockKey(workspace: StoredGitWorkspace): string {
  return `${workspace.commonGitDir}\0${workspace.summary.targetBranch}`;
}

export function codexReviewArgs(worktreePath: string, targetSha: string, prompt: string): string[] {
  return [
    "-C",
    worktreePath,
    "-s",
    "read-only",
    "-a",
    "never",
    "exec",
    "--ephemeral",
    "review",
    "--base",
    targetSha,
    prompt
  ];
}

async function acquireFileLock(key: string): Promise<{ release(): Promise<void> }> {
  const commonGitDir = key.split("\0", 1)[0]!;
  const root = join(commonGitDir, "muxpilot-locks");
  const path = join(root, `${createHash("sha256").update(key).digest("hex")}.lock`);
  await mkdir(root, { recursive: true });
  let handle: FileHandle | null = null;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: nowIso() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 15 * 60_000) await unlink(path).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!handle) throw new GitWorkspaceError("Timed out waiting for another Git workspace operation", "workspace_locked");
  return {
    async release() {
      await handle?.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    }
  };
}
