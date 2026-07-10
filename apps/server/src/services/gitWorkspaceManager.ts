import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitInspection,
  GitFinalizeResponse,
  GitReviewFinding,
  GitRepositoryProbe,
  GitRevisionSpec,
  GitReviewSummary,
  GitWorkspaceAction,
  GitWorkspaceSummary
} from "@muxpilot/core";
import {
  GitWorkspaceCoordinator,
  GitWorkspaceError,
  managedTargetRef,
  type GitRotationResult,
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
  reviewRunner?: (worktreePath: string, targetSha: string, prompt: string) => Promise<StructuredReview>;
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

  targetBranchExists(path: string, branch: string): Promise<boolean> {
    return this.coordinator.targetBranchExists(path, branch);
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
      compatibilityWarnings: provisioned.compatibilityWarnings,
      generation: 1,
      lastCompletion: null
    };
    const stored: StoredGitWorkspace = {
      id,
      sessionId: null,
      commonGitDir: provisioned.commonGitDir,
      targetRef: provisioned.targetRef,
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
    for (const stored of await this.db.listGitWorkspaces()) {
      if (stored.summary.state === "cleaned") continue;
      let workspace = stored;
      try {
        workspace = await this.ensureManagedTarget(workspace);
        await this.coordinator.recoverIntegrationWorktree(coordinates(workspace), this.options.integrationRoot);
        if (workspace.summary.state === "rotation_pending") {
          const generation = (workspace.summary.generation ?? 1) + 1;
          const rotated = await this.coordinator.rotate(coordinates(workspace), workspace.summary.inspections, generation, true);
          await this.save(workspace, completedRotationSummary(workspace.summary, rotated, generation));
          continue;
        }
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
      const remote = await this.coordinator.remoteStatus(coordinates(workspace)).catch(() => ({
        remoteSha: workspace.summary.remoteSha,
        ahead: workspace.summary.remoteAheadBy,
        behind: workspace.summary.remoteBehindBy
      }));
      return await this.save(workspace, {
        ...workspace.summary,
        targetSha: status.targetSha,
        sessionHeadSha: status.sessionHeadSha,
        dirty: status.dirty,
        aheadBy: status.aheadBy,
        targetCheckedOutAt: status.targetCheckedOutAt,
        remoteSha: remote.remoteSha,
        remoteAheadBy: remote.ahead,
        remoteBehindBy: remote.behind,
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
    return (await this.withLock(key, () => this.push(workspace))).summary;
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
    return (await this.withLock(`${workspace.commonGitDir}\0${workspace.summary.targetBranch}`, async () => {
      const added = await this.addInspection(workspace, revision, false);
      const inspection = added.summary.inspections.at(-1);
      return inspection ? this.materializeInspection(added, inspection.id) : added;
    })).summary;
  }

  async finalizeWithToken(workspaceId: string, token: string): Promise<GitFinalizeResponse> {
    const workspace = requireWorkspace(await this.db.getGitWorkspace(workspaceId));
    if (!validToken(workspace.helperToken, token)) throw new GitWorkspaceError("Invalid Git workspace capability", "invalid_capability");
    const reviewed = await this.prepareReview(workspace);
    const result = parseStructuredReview(reviewed.summary.review?.report ?? "");
    if (result.verdict !== "pass" || result.findings.length > 0) {
      return { status: "changes_requested", summary: result.summary, findings: result.findings, workspace: reviewed.summary };
    }
    const commitCount = reviewed.summary.aheadBy;
    const integrated = await this.withLock(workspaceLockKey(reviewed), () => this.integrate(reviewed));
    const rotated = await this.withLock(workspaceLockKey(integrated), () => this.rotateGeneration(integrated, commitCount, result.summary));
    return {
      status: "integrated",
      targetSha: rotated.summary.targetSha,
      generation: rotated.summary.generation ?? 1,
      workspace: rotated.summary
    };
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
      const structured = await (this.options.reviewRunner ?? runStructuredReview)(current.summary.worktreePath, current.summary.targetSha, prompt);
      const passed = structured.verdict === "pass" && structured.findings.length === 0;
      const completed = {
        ...review,
        status: passed ? "passed" as const : "changes_requested" as const,
        report: JSON.stringify(structured),
        completedAt: nowIso()
      };
      return this.save(current, {
        ...current.summary,
        review: completed,
        reviewCurrent: passed,
        state: passed ? "ready_to_integrate" : "active",
        lastError: null
      });
    } catch (error) {
      const failed = { ...review, status: "failed" as const, report: errorMessage(error), completedAt: nowIso() };
      await this.save(current, { ...current.summary, review: failed, reviewCurrent: false, state: "active", lastError: failed.report });
      throw new GitWorkspaceError("Independent Codex review failed", "review_failed", failed.report);
    }
  }

  private async integrate(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    const current = await this.refresh(workspace);
    if (!current.summary.reviewCurrent) {
      throw new GitWorkspaceError("A current review is required before integration", "review_required");
    }
    const integrating = await this.save(current, { ...current.summary, state: "integrating", lastError: null });
    try {
      const result = await this.coordinator.integrate(
        coordinates(integrating),
        integrating.summary.targetSha,
        integrating.summary.sessionHeadSha
      );
      return this.save(integrating, {
        ...integrating.summary,
        state: "integrated",
        targetSha: result.targetSha,
        sessionHeadSha: result.targetSha,
        dirty: false,
        aheadBy: 0,
        cleanupEligible: true,
        lastError: null
      });
    } catch (error) {
      await this.save(integrating, { ...integrating.summary, state: "active", reviewCurrent: false, lastError: errorMessage(error) });
      throw normalizeError(error);
    }
  }

  private async rotateGeneration(workspace: StoredGitWorkspace, commitCount: number, reviewSummary: string): Promise<StoredGitWorkspace> {
    const generation = (workspace.summary.generation ?? 1) + 1;
    const pending = await this.save(workspace, {
      ...workspace.summary,
      state: "rotation_pending",
      lastCompletion: {
        generation: generation - 1,
        integratedSha: workspace.summary.targetSha,
        completedAt: nowIso(),
        commitCount,
        reviewSummary
      },
      lastError: null
    });
    try {
      await this.coordinator.recoverIntegrationWorktree(coordinates(pending), this.options.integrationRoot);
      const rotated = await this.coordinator.rotate(coordinates(pending), pending.summary.inspections, generation);
      return this.save(pending, completedRotationSummary(pending.summary, rotated, generation));
    } catch (error) {
      await this.save(pending, { ...pending.summary, state: "rotation_pending", lastError: errorMessage(error) });
      throw normalizeError(error);
    }
  }

  private async push(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
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

  private async save(workspace: StoredGitWorkspace, summary: GitWorkspaceSummary): Promise<StoredGitWorkspace> {
    const updatedAt = nowIso();
    const next = { ...workspace, summary, updatedAt };
    await this.db.upsertGitWorkspace(next, updatedAt);
    return next;
  }

  private async ensureManagedTarget(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    const targetRef = workspace.targetRef ?? managedTargetRef(workspace.summary.targetRemote, workspace.summary.targetBranch);
    const current = { ...workspace, targetRef };
    const targetSha = await this.coordinator.ensureManagedTargetRef(coordinates(current));
    if (workspace.targetRef === targetRef && workspace.summary.targetSha === targetSha) return workspace;
    return this.save(current, { ...workspace.summary, targetSha });
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
    targetRef: workspace.targetRef ?? managedTargetRef(summary.targetRemote, summary.targetBranch),
    sourceSha: summary.sourceSha,
    targetSha: summary.targetSha,
    sessionBranch: summary.sessionBranch,
    worktreePath: summary.worktreePath
  };
}

function recoverableState(state: GitWorkspaceSummary["state"]): GitWorkspaceSummary["state"] {
  return ["integrated", "rotation_pending", "cleanup_pending", "cleaned"].includes(state) ? state : "active";
}

function completedRotationSummary(summary: GitWorkspaceSummary, rotated: GitRotationResult, generation: number): GitWorkspaceSummary {
  return {
    ...summary,
    state: "active",
    generation,
    sourceSha: rotated.targetSha,
    targetSha: rotated.targetSha,
    sessionBranch: rotated.sessionBranch,
    sessionHeadSha: rotated.sessionHeadSha,
    dirty: false,
    aheadBy: 0,
    review: null,
    reviewCurrent: false,
    inspections: [],
    cleanupEligible: false,
    lastError: null
  };
}

function requireWorkspace(workspace: StoredGitWorkspace | null): StoredGitWorkspace {
  if (!workspace) throw new GitWorkspaceError("Git workspace not found", "missing_workspace");
  return workspace;
}

function reviewPrompt(summary: GitWorkspaceSummary): string {
  const inspections = summary.inspections.map((inspection) => `${inspection.commitSha} (${revisionLabel(inspection.requested)})`).join(", ");
  return [
    `Review the committed changes from ${summary.targetSha} to ${summary.sessionHeadSha}.`,
    "Focus on actionable correctness defects, regressions, missing tests, and operational risks. Do not edit files.",
    "Return pass with an empty findings array only when no fixes are necessary; otherwise return changes_requested and every actionable finding.",
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
  return `${workspace.commonGitDir}\0${workspace.targetRef ?? managedTargetRef(workspace.summary.targetRemote, workspace.summary.targetBranch)}`;
}

export interface StructuredReview {
  verdict: "pass" | "changes_requested";
  summary: string;
  findings: GitReviewFinding[];
}

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "changes_requested"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "path", "line"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          path: { type: ["string", "null"] },
          line: { type: ["integer", "null"] }
        }
      }
    }
  }
};

async function runStructuredReview(worktreePath: string, targetSha: string, prompt: string): Promise<StructuredReview> {
  const temp = await mkdtemp(join(tmpdir(), "muxpilot-review-"));
  const schemaPath = join(temp, "schema.json");
  const patchPath = join(temp, "changes.patch");
  const outputPath = join(temp, "result.json");
  try {
    await Promise.all([
      execFileAsync("git", gitReviewDiffArgs(targetSha, patchPath), { cwd: worktreePath }),
      writeFile(schemaPath, JSON.stringify(REVIEW_SCHEMA))
    ]);
    await execFileAsync("codex", codexReviewArgs(worktreePath, `${prompt} The exact patch to review is at ${patchPath}. Begin with that patch and inspect repository context as needed.`, schemaPath, outputPath), {
      cwd: worktreePath,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024
    });
    return parseStructuredReview(await readFile(outputPath, "utf8"));
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function gitReviewDiffArgs(targetSha: string, patchPath: string): string[] {
  return ["diff", "--binary", `--output=${patchPath}`, targetSha, "HEAD", "--"];
}

export function parseStructuredReview(value: string): StructuredReview {
  const parsed = JSON.parse(value) as Partial<StructuredReview>;
  const findings = Array.isArray(parsed.findings) ? parsed.findings.filter(validFinding) : [];
  if ((parsed.verdict !== "pass" && parsed.verdict !== "changes_requested") || typeof parsed.summary !== "string") {
    throw new GitWorkspaceError("Codex review returned an invalid structured result", "invalid_review");
  }
  return { verdict: parsed.verdict, summary: parsed.summary, findings };
}

function validFinding(value: unknown): value is GitReviewFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<GitReviewFinding>;
  return typeof finding.title === "string" && typeof finding.body === "string" &&
    (finding.path === null || typeof finding.path === "string") &&
    (finding.line === null || Number.isInteger(finding.line));
}

export function codexReviewArgs(worktreePath: string, prompt: string, schemaPath: string, outputPath: string): string[] {
  return [
    "-C",
    worktreePath,
    "-s",
    "read-only",
    "-a",
    "never",
    "exec",
    "--ephemeral",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
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
