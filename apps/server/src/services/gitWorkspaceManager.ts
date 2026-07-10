import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GitInspection,
  GitFinalizeOptions,
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
  type GitWorkspaceCoordinates,
  type ProvisionGitWorkspaceRequest
} from "@muxpilot/git-workspaces";
import type { AppDatabase, StoredGitWorkspace } from "../db/database.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";

const execFileAsync = promisify(execFile);
export const REVIEW_TIMEOUT_MS = 5 * 60_000;

interface GitWorkspaceManagerOptions {
  worktreeRoot: string;
  sessionRoot: string;
  inspectionRoot: string;
  integrationRoot: string;
  reviewRunner?: (worktreePath: string, targetSha: string, prompt: string) => Promise<StructuredReview>;
}

export class GitWorkspaceManager {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly finalizations = new Map<string, Promise<GitFinalizeResponse>>();

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

  async provision(request: Omit<ProvisionGitWorkspaceRequest, "workspaceId" | "worktreeRoot" | "sessionRoot">): Promise<StoredGitWorkspace> {
    const id = eventId();
    const createdAt = nowIso();
    const provisioned = await this.coordinator.provision({
      ...request,
      workspaceId: id,
      worktreeRoot: this.options.worktreeRoot,
      sessionRoot: this.options.sessionRoot
    });
    const summary: GitWorkspaceSummary = {
      id,
      state: "idle",
      entryPath: provisioned.entryPath,
      repoRoot: provisioned.repoRoot,
      targetBranch: provisioned.targetBranch,
      targetRemote: provisioned.targetRemote,
      targetSource: provisioned.targetSource,
      sourceSha: provisioned.sourceSha,
      sourceFetchedAt: provisioned.sourceFetchedAt,
      sourceFreshness: provisioned.sourceFreshness,
      targetSha: provisioned.targetSha,
      sessionBranch: null,
      sessionHeadSha: provisioned.targetSha,
      worktreePath: null,
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
      generation: 0,
      lastCompletion: null
    };
    const stored: StoredGitWorkspace = {
      id,
      sessionId: null,
      sessionName: request.sessionName,
      commonGitDir: provisioned.commonGitDir,
      targetRef: provisioned.targetRef,
      controlPath: provisioned.controlPath,
      implementationRoot: provisioned.implementationRoot,
      recoveryRef: null,
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

  async beginWithToken(workspaceId: string, token: string): Promise<GitWorkspaceSummary> {
    const workspace = requireWorkspace(await this.db.getGitWorkspace(workspaceId));
    if (!validToken(workspace.helperToken, token)) throw new GitWorkspaceError("Invalid Git workspace capability", "invalid_capability");
    return (await this.withLock(workspaceLockKey(workspace), async () => {
      const current = requireWorkspace(await this.db.getGitWorkspace(workspaceId));
      if (current.summary.worktreePath && current.summary.sessionBranch && await pathExists(current.summary.worktreePath)) {
        return this.refresh(current);
      }
      const reconciled = await this.reconcile(current, true);
      const suspended = reconciled.summary.state === "suspended" && Boolean(reconciled.summary.sessionBranch);
      const generation = suspended ? Math.max(1, current.summary.generation ?? 1) : (current.summary.generation ?? 0) + 1;
      const materialized = await this.coordinator.materialize(
        coordinates(reconciled),
        implementationRoot(reconciled, this.options.worktreeRoot),
        reconciled.sessionName ?? reconciled.id,
        generation,
        reconciled.recoveryRef ?? null
      );
      const status = await this.coordinator.status({
        ...coordinates(reconciled),
        sessionBranch: materialized.sessionBranch,
        worktreePath: materialized.worktreePath,
        targetSha: materialized.targetSha
      });
      const dependencyLinks = await this.coordinator.linkDependencies(reconciled.summary.repoRoot, materialized.worktreePath);
      return this.save(
        { ...reconciled, recoveryRef: materialized.recoveryError ? reconciled.recoveryRef : null },
        {
          ...reconciled.summary,
          state: materialized.recoveryError ? "integration_conflict" : "active",
          generation,
          sourceSha: materialized.targetSha,
          targetSha: materialized.targetSha,
          sessionBranch: materialized.sessionBranch,
          sessionHeadSha: materialized.sessionHeadSha,
          worktreePath: materialized.worktreePath,
          dirty: status.dirty,
          aheadBy: status.aheadBy,
          review: null,
          reviewCurrent: false,
          finalization: null,
          dependencyLinks,
          lastError: materialized.recoveryError ?? reconciled.summary.lastError
        }
      );
    })).summary;
  }

  async suspendBySession(sessionId: string, removeControl = false): Promise<GitWorkspaceSummary | null> {
    const workspace = await this.db.getGitWorkspaceBySession(sessionId);
    if (!workspace) return null;
    let suspended: StoredGitWorkspace;
    try {
      suspended = await this.withLock(workspaceLockKey(workspace), async () => {
        const current = requireWorkspace(await this.db.getGitWorkspace(workspace.id));
        if (!current.summary.worktreePath || !current.summary.sessionBranch || !(await pathExists(current.summary.worktreePath))) {
          return current;
        }
        const refreshed = await this.refresh(current);
        if (!refreshed.summary.dirty && refreshed.summary.aheadBy === 0 && !refreshed.recoveryRef) {
          await this.coordinator.cleanupIntegrated(coordinates(refreshed), refreshed.summary.inspections);
          return this.save(refreshed, idleSummary(refreshed.summary));
        }
        const recoveryRef = refreshed.recoveryRef ?? `refs/muxpilot/recovery/${current.id}/g${Math.max(1, current.summary.generation ?? 1)}`;
        const result = refreshed.recoveryRef
          ? {
              targetSha: refreshed.summary.targetSha,
              sessionHeadSha: refreshed.summary.sessionHeadSha,
              aheadBy: refreshed.summary.aheadBy,
              recoveryRef: refreshed.recoveryRef
            }
          : await this.coordinator.suspend(coordinates(refreshed), recoveryRef);
        const checkpointed = await this.save(
          { ...refreshed, recoveryRef: result.recoveryRef },
          {
            ...refreshed.summary,
            state: "suspension_pending",
            targetSha: result.targetSha,
            sessionHeadSha: result.sessionHeadSha,
            dirty: Boolean(result.recoveryRef),
            aheadBy: result.aheadBy,
            reviewCurrent: false,
            lastError: null
          }
        );
        await this.coordinator.removeSuspendedWorktree(coordinates(checkpointed));
        return this.save(checkpointed, { ...checkpointed.summary, state: "suspended", worktreePath: null });
      });
    } catch (error) {
      const current = await this.db.getGitWorkspace(workspace.id);
      if (current) await this.save(current, { ...current.summary, lastError: errorMessage(error) });
      throw error;
    }
    if (removeControl && suspended.controlPath) await rm(suspended.controlPath, { recursive: true, force: true }).catch(() => undefined);
    return suspended.summary;
  }

  async ensureControlPath(workspace: StoredGitWorkspace): Promise<string> {
    const path = workspace.controlPath ?? join(this.options.sessionRoot, "legacy", workspace.id);
    const root = implementationRoot(workspace, this.options.worktreeRoot);
    await Promise.all([mkdir(path, { recursive: true }), mkdir(root, { recursive: true })]);
    if (workspace.controlPath !== path || workspace.implementationRoot !== root) {
      await this.save({ ...workspace, controlPath: path, implementationRoot: root }, workspace.summary);
    }
    return path;
  }

  async recover(): Promise<void> {
    for (const stored of await this.db.listGitWorkspaces()) {
      if (stored.summary.state === "cleaned") continue;
      let workspace = stored;
      try {
        if (workspace.summary.finalization && ["queued", "reconciling", "reviewing", "integrating", "cleanup"].includes(workspace.summary.finalization.status)) {
          workspace = await this.setFinalizationStatus(workspace, "interrupted", "Server restarted before finalization completed; rerun finish to resume safely");
        }
        workspace = await this.ensureManagedTarget(workspace);
        workspace = await this.reconcile(workspace, true);
        const localSync = await this.coordinator.syncLocalTarget(coordinates(workspace));
        if (workspace.summary.reconciliation) {
          workspace = await this.save(workspace, {
            ...workspace.summary,
            reconciliation: {
              ...workspace.summary.reconciliation,
              localSha: localSync === "updated" || localSync === "current" ? workspace.summary.targetSha : workspace.summary.reconciliation.localSha,
              localSync
            }
          });
        }
        await this.coordinator.recoverIntegrationWorktree(coordinates(workspace), this.options.integrationRoot);
        if (workspace.summary.worktreePath && !(await pathExists(workspace.summary.worktreePath))) {
          if (["integrated", "rotation_pending", "cleanup_pending"].includes(workspace.summary.state)) {
            workspace = await this.ensureRecoveredCompletion(workspace);
            const targetSha = await this.coordinator.cleanupInactiveIntegrated(coordinates(workspace), workspace.summary.inspections);
            const cleaned = await this.save(workspace, idleSummary({ ...workspace.summary, targetSha, sessionHeadSha: targetSha }));
            await this.setFinalizationStatus(cleaned, "completed");
            continue;
          }
          const status = await this.coordinator.inactiveStatus(coordinates(workspace));
          workspace = await this.save(workspace, {
            ...workspace.summary,
            state: workspace.summary.sessionBranch ? "suspended" : "idle",
            worktreePath: null,
            targetSha: status.targetSha,
            sessionHeadSha: status.sessionHeadSha,
            dirty: Boolean(workspace.recoveryRef),
            aheadBy: status.aheadBy,
            lastError: workspace.summary.dirty ? "Implementation worktree disappeared before uncommitted changes could be preserved" : null
          });
        }
        if (
          workspace.summary.worktreePath &&
          ["integrated", "rotation_pending", "cleanup_pending"].includes(workspace.summary.state)
        ) {
          workspace = await this.ensureRecoveredCompletion(workspace);
          const cleaned = await this.cleanupCompleted(workspace);
          await this.setFinalizationStatus(cleaned, "completed");
          continue;
        }
        await this.refresh(workspace);
      } catch (error) {
        const current = await this.db.getGitWorkspace(workspace.id) ?? workspace;
        await this.save(current, { ...current.summary, lastError: errorMessage(error) });
      }
    }
  }

  async refresh(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    if (workspace.summary.state === "cleaned") return workspace;
    try {
      const status = workspace.summary.worktreePath && workspace.summary.sessionBranch
        ? await this.coordinator.status(coordinates(workspace))
        : await this.coordinator.inactiveStatus(coordinates(workspace));
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
        cleanupEligible: false,
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
    return (await this.withLock(key, () => this.push(workspace, action.expectedTargetSha))).summary;
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
      return this.addInspection(workspace, revision, false);
    })).summary;
  }

  async finalizeWithToken(workspaceId: string, token: string, options: GitFinalizeOptions = {}): Promise<GitFinalizeResponse> {
    const workspace = requireWorkspace(await this.db.getGitWorkspace(workspaceId));
    if (!validToken(workspace.helperToken, token)) throw new GitWorkspaceError("Invalid Git workspace capability", "invalid_capability");
    if (!workspace.summary.worktreePath && workspace.summary.finalization?.status === "completed" && workspace.summary.lastCompletion?.integratedSha === workspace.summary.targetSha) {
      return {
        status: "integrated",
        targetSha: workspace.summary.targetSha,
        generation: workspace.summary.lastCompletion.generation,
        reviewed: workspace.summary.lastCompletion.reviewDisposition !== "bypassed",
        workspace: workspace.summary
      };
    }
    const existing = this.finalizations.get(workspaceId);
    if (existing) return existing;
    const operation = this.runFinalization(workspace, options);
    this.finalizations.set(workspaceId, operation);
    void operation.finally(() => {
      if (this.finalizations.get(workspaceId) === operation) this.finalizations.delete(workspaceId);
    }).catch(() => undefined);
    return operation;
  }

  async statusWithToken(workspaceId: string, token: string): Promise<GitWorkspaceSummary> {
    const workspace = requireWorkspace(await this.db.getGitWorkspace(workspaceId));
    if (!validToken(workspace.helperToken, token)) throw new GitWorkspaceError("Invalid Git workspace capability", "invalid_capability");
    return (await this.refresh(workspace)).summary;
  }

  async detachDependenciesWithToken(workspaceId: string, token: string, requested: string[] | null): Promise<GitWorkspaceSummary> {
    const workspace = requireWorkspace(await this.db.getGitWorkspace(workspaceId));
    if (!validToken(workspace.helperToken, token)) throw new GitWorkspaceError("Invalid Git workspace capability", "invalid_capability");
    if (!workspace.summary.worktreePath) throw new GitWorkspaceError("Begin an implementation worktree before detaching dependencies", "workspace_idle");
    const available = workspace.summary.dependencyLinks ?? [];
    const paths = requested?.length ? requested : available.filter((link) => link.linked).map((link) => link.relativePath);
    const detached = new Set(await this.coordinator.detachDependencyLinks(workspace.summary.worktreePath, paths));
    return (await this.save(workspace, {
      ...workspace.summary,
      dependencyLinks: available.map((link) => detached.has(link.relativePath) ? { ...link, linked: false } : link)
    })).summary;
  }

  private async runFinalization(workspace: StoredGitWorkspace, options: GitFinalizeOptions): Promise<GitFinalizeResponse> {
    if (!workspace.summary.worktreePath || !workspace.summary.sessionBranch) {
      throw new GitWorkspaceError("Begin an implementation worktree before finalizing", "workspace_idle");
    }
    const now = nowIso();
    workspace = await this.save(workspace, {
      ...workspace.summary,
      finalization: {
        id: eventId(),
        generation: workspace.summary.generation ?? 1,
        candidateSha: workspace.summary.sessionHeadSha,
        allowUnreviewed: options.allowUnreviewed === true,
        status: "queued",
        startedAt: now,
        updatedAt: now,
        error: null
      }
    });
    try {
      if (options.allowUnreviewed) return await this.finalizeWithoutReview(workspace);
      const reviewed = await this.prepareReview(workspace);
      const result = parseStructuredReview(reviewed.summary.review?.report ?? "");
      if (result.verdict !== "pass" || result.findings.length > 0) {
        const changed = await this.setFinalizationStatus(reviewed, "changes_requested");
        return { status: "changes_requested", summary: result.summary, findings: result.findings, workspace: changed.summary };
      }
      const commitCount = reviewed.summary.aheadBy;
      const integrated = await this.withLock(workspaceLockKey(reviewed), () => this.integrate(reviewed));
      const completed = await this.withLock(workspaceLockKey(integrated), () =>
        this.completeGeneration(integrated, commitCount, result.summary, "passed")
      );
      const finalized = await this.setFinalizationStatus(completed, "completed");
      return {
        status: "integrated",
        targetSha: finalized.summary.targetSha,
        generation: finalized.summary.generation ?? 1,
        reviewed: true,
        workspace: finalized.summary
      };
    } catch (error) {
      const current = await this.db.getGitWorkspace(workspace.id);
      if (current) await this.setFinalizationStatus(current, "failed", errorMessage(error));
      throw error;
    }
  }

  private async finalizeWithoutReview(workspace: StoredGitWorkspace): Promise<GitFinalizeResponse> {
    workspace = await this.setFinalizationStatus(workspace, "reconciling");
    const commitCount = workspace.summary.aheadBy;
    const integrated = await this.withLock(workspaceLockKey(workspace), () => this.integrate(workspace, true));
    const reviewSummary = workspace.summary.review?.report
      ? `Independent review bypassed after explicit user approval. Last review: ${workspace.summary.review.report}`
      : "Independent review bypassed after explicit user approval.";
    const completed = await this.withLock(workspaceLockKey(integrated), () =>
      this.completeGeneration(integrated, commitCount, reviewSummary, "bypassed")
    );
    const finalized = await this.setFinalizationStatus(completed, "completed");
    return {
      status: "integrated",
      targetSha: finalized.summary.targetSha,
      generation: finalized.summary.generation ?? 1,
      reviewed: false,
      workspace: finalized.summary
    };
  }

  private async prepareReview(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    workspace = await this.setFinalizationStatus(workspace, "reconciling");
    let current = await this.withLock(workspaceLockKey(workspace), () => this.reconcile(workspace, true));
    try {
      const prepared = await this.withLock(workspaceLockKey(current), () => this.coordinator.prepareIntegration(coordinates(current)));
      current = await this.save(current, {
        ...current.summary,
        state: "reviewing",
        targetSha: prepared.targetSha,
        sessionHeadSha: prepared.sessionHeadSha,
        dirty: prepared.dirty,
        aheadBy: prepared.aheadBy,
        targetCheckedOutAt: prepared.targetCheckedOutAt,
        review: null,
        reviewCurrent: false,
        lastError: current.summary.reconciliation?.status === "cached" ? current.summary.lastError : null
      });
    } catch (error) {
      const conflict = error instanceof GitWorkspaceError && ["integration_conflict", "target_reconciliation_conflict"].includes(error.code);
      await this.save(current, {
        ...current.summary,
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
    current = await this.save(current, {
      ...current.summary,
      review,
      state: "reviewing",
      finalization: current.summary.finalization ? { ...current.summary.finalization, status: "reviewing", updatedAt: nowIso() } : null
    });
    try {
      const prompt = reviewPrompt(current.summary);
      const structured = await (this.options.reviewRunner ?? runStructuredReview)(requireWorktreePath(current.summary), current.summary.targetSha, prompt);
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

  private async integrate(workspace: StoredGitWorkspace, allowUnreviewed = false): Promise<StoredGitWorkspace> {
    const reconciled = await this.reconcile(workspace, true);
    let current = await this.refresh(reconciled);
    if (allowUnreviewed) {
      const prepared = await this.coordinator.prepareIntegration(coordinates(current));
      current = await this.save(current, {
        ...current.summary,
        targetSha: prepared.targetSha,
        sessionHeadSha: prepared.sessionHeadSha,
        dirty: prepared.dirty,
        aheadBy: prepared.aheadBy,
        targetCheckedOutAt: prepared.targetCheckedOutAt
      });
    }
    if (!current.summary.reviewCurrent && !allowUnreviewed) {
      throw new GitWorkspaceError("A current review is required before integration", "review_required");
    }
    const integrating = await this.save(current, {
      ...current.summary,
      state: "integrating",
      finalization: current.summary.finalization ? { ...current.summary.finalization, status: "integrating", updatedAt: nowIso() } : null,
      lastError: null
    });
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

  private async completeGeneration(
    workspace: StoredGitWorkspace,
    commitCount: number,
    reviewSummary: string,
    reviewDisposition: "passed" | "bypassed"
  ): Promise<StoredGitWorkspace> {
    const generation = Math.max(1, workspace.summary.generation ?? 1);
    const localSync = await this.coordinator.syncLocalTarget(coordinates(workspace));
    const pending = await this.save(workspace, {
      ...workspace.summary,
      reconciliation: workspace.summary.reconciliation ? {
        ...workspace.summary.reconciliation,
        localSha: localSync === "updated" || localSync === "current" ? workspace.summary.targetSha : workspace.summary.reconciliation.localSha,
        localSync
      } : workspace.summary.reconciliation,
      state: "cleanup_pending",
      finalization: workspace.summary.finalization ? { ...workspace.summary.finalization, status: "cleanup", updatedAt: nowIso() } : null,
      lastCompletion: {
        generation,
        integratedSha: workspace.summary.targetSha,
        completedAt: nowIso(),
        commitCount,
        reviewSummary,
        reviewDisposition
      },
      lastError: null
    });
    try {
      return await this.cleanupCompleted(pending);
    } catch (error) {
      await this.save(pending, { ...pending.summary, state: "cleanup_pending", lastError: errorMessage(error) });
      throw normalizeError(error);
    }
  }

  private async cleanupCompleted(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    if (workspace.recoveryRef) await this.coordinator.deleteRef(workspace.summary.repoRoot, workspace.recoveryRef);
    const targetSha = await this.coordinator.cleanupIntegrated(coordinates(workspace), workspace.summary.inspections);
    return this.save({ ...workspace, recoveryRef: null }, idleSummary({
      ...workspace.summary,
      targetSha,
      sessionHeadSha: targetSha
    }));
  }

  private async push(workspace: StoredGitWorkspace, expectedTargetSha: string): Promise<StoredGitWorkspace> {
    try {
      const reconciled = await this.reconcile(workspace, false);
      if (reconciled.summary.targetSha !== expectedTargetSha) {
        return this.save(reconciled, {
          ...reconciled.summary,
          pushConfirmationRequired: true,
          lastError: `Target changed from ${expectedTargetSha} to ${reconciled.summary.targetSha}; confirm the refreshed target before pushing`
        });
      }
      const pushed = await this.coordinator.push(coordinates(reconciled));
      return this.save(reconciled, {
        ...reconciled.summary,
        reconciliation: reconciled.summary.reconciliation ? {
          ...reconciled.summary.reconciliation,
          remoteSha: pushed.remoteSha,
          remoteFreshness: "fresh"
        } : reconciled.summary.reconciliation,
        remoteSha: pushed.remoteSha,
        remoteAheadBy: 0,
        remoteBehindBy: 0,
        pushConfirmationRequired: false,
        lastError: null
      });
    } catch (error) {
      const current = await this.db.getGitWorkspace(workspace.id) ?? workspace;
      await this.save(current, { ...current.summary, lastError: errorMessage(error) });
      throw normalizeError(error);
    }
  }

  private async save(workspace: StoredGitWorkspace, summary: GitWorkspaceSummary): Promise<StoredGitWorkspace> {
    const updatedAt = nowIso();
    const next = { ...workspace, summary, updatedAt };
    await this.db.upsertGitWorkspace(next, updatedAt);
    return next;
  }

  private setFinalizationStatus(
    workspace: StoredGitWorkspace,
    status: NonNullable<GitWorkspaceSummary["finalization"]>["status"],
    error: string | null = null
  ): Promise<StoredGitWorkspace> {
    if (!workspace.summary.finalization) return Promise.resolve(workspace);
    return this.save(workspace, {
      ...workspace.summary,
      finalization: { ...workspace.summary.finalization, status, updatedAt: nowIso(), error }
    });
  }

  private ensureRecoveredCompletion(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    if (workspace.summary.lastCompletion) return Promise.resolve(workspace);
    const generation = Math.max(1, workspace.summary.finalization?.generation ?? workspace.summary.generation ?? 1);
    return this.save(workspace, {
      ...workspace.summary,
      state: "cleanup_pending",
      lastCompletion: {
        generation,
        integratedSha: workspace.summary.targetSha,
        completedAt: nowIso(),
        commitCount: 0,
        reviewSummary: "Recovered an integration that completed before finalization was interrupted.",
        reviewDisposition: workspace.summary.finalization?.allowUnreviewed ? "bypassed" : "passed"
      }
    });
  }

  private async ensureManagedTarget(workspace: StoredGitWorkspace): Promise<StoredGitWorkspace> {
    const targetRef = workspace.targetRef ?? managedTargetRef(workspace.summary.targetRemote, workspace.summary.targetBranch);
    const current = { ...workspace, targetRef };
    const targetSha = await this.coordinator.ensureManagedTargetRef(coordinates(current));
    if (workspace.targetRef === targetRef && workspace.summary.targetSha === targetSha) return workspace;
    return this.save(current, { ...workspace.summary, targetSha });
  }

  private async reconcile(workspace: StoredGitWorkspace, allowCachedRemote: boolean): Promise<StoredGitWorkspace> {
    try {
      const result = await this.coordinator.reconcileTarget(coordinates(workspace), this.options.integrationRoot, allowCachedRemote);
      return this.save(workspace, {
        ...workspace.summary,
        targetSha: result.managedSha,
        reconciliation: result,
        lastError: result.status === "cached" ? "Target reconciled using cached remote state; publication requires a fresh fetch" : null
      });
    } catch (error) {
      if (error instanceof GitWorkspaceError && error.code === "target_reconciliation_conflict") {
        const worktreePath = error.causeText?.split("\n")[0] ?? null;
        await this.save(workspace, {
          ...workspace.summary,
          state: "integration_conflict",
          reconciliation: {
            status: "conflict",
            managedRef: workspace.targetRef ?? managedTargetRef(workspace.summary.targetRemote, workspace.summary.targetBranch),
            managedSha: workspace.summary.targetSha,
            localRef: `refs/heads/${workspace.summary.targetBranch}`,
            localSha: null,
            remoteRef: workspace.summary.targetRemote ? `refs/heads/${workspace.summary.targetBranch}` : null,
            remoteSha: null,
            remoteFreshness: "local",
            worktreePath,
            localSync: "current"
          },
          lastError: error.message
        });
      }
      throw error;
    }
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
  return state === "rotation_pending" ? "cleanup_pending" : state;
}

function idleSummary(summary: GitWorkspaceSummary): GitWorkspaceSummary {
  return {
    ...summary,
    state: "idle",
    sourceSha: summary.targetSha,
    sessionBranch: null,
    sessionHeadSha: summary.targetSha,
    worktreePath: null,
    dirty: false,
    aheadBy: 0,
    review: null,
    reviewCurrent: false,
    inspections: summary.inspections.map((inspection) => ({ ...inspection, worktreePath: null })),
    cleanupEligible: false,
    lastError: null
  };
}

function requireWorktreePath(summary: GitWorkspaceSummary): string {
  if (!summary.worktreePath) throw new GitWorkspaceError("No implementation worktree is active", "workspace_idle");
  return summary.worktreePath;
}

function implementationRoot(workspace: StoredGitWorkspace, worktreeRoot: string): string {
  return workspace.implementationRoot ?? join(worktreeRoot, "legacy", workspace.id);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
      timeout: REVIEW_TIMEOUT_MS,
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
