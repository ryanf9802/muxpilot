import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  CodexModel,
  CollaborationMode,
  CreateSessionRequest,
  GitWorkspaceSummary,
  ManagedSession,
  PlanActionChoice,
  QuestionAnswerRequest,
  QuestionRequest,
  QueuedInput,
  ResolveApprovalRequest,
  SessionResourceUsage,
  SessionForkOrigin,
  SessionHistoryResult,
  SessionRecoveryCandidate,
  SessionRecoveryIncident,
  RestoreSessionRecoveryResponse,
  RestoreSessionRecoveryResult,
  SessionAction,
  SessionDirectorySuggestion,
  SessionModelSettings,
  SessionModelSelections,
  SessionStatus,
  SessionTransferImportMapping,
  SessionTransferImportResult,
  TranscriptPageResponse,
  TranscriptSearchResponse,
  TmuxPane
} from "@muxpilot/core";
import { canToggleFastMode, hasCompleteProposedPlan, isValidSessionName, normalizeGitWorkspaceSummary, normalizeSessionName, sessionHistoryIdentity } from "@muxpilot/core";
import type { AppDatabase, StoredGitWorkspace } from "../db/database.js";
import { CodexSessionStore, type CodexSessionFile } from "../codex/codexSessionStore.js";
import { PARSER_VERSION, appendSkillNamesForDisplay, parseCodexJsonl } from "../codex/parser.js";
import {
  interactiveApprovalKeys,
  parseInteractiveApprovalPrompt,
  type InteractiveApprovalPrompt
} from "../codex/approvalPrompt.js";
import { isCodexStartupFailureCapture, TmuxAdapter } from "../tmux/tmuxAdapter.js";
import { eventId, stableId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { loadRepoMetadata } from "./gitMetadata.js";
import type { EventBus } from "./eventBus.js";
import type { CodexProcessInfo } from "../codex/codexProcessResolver.js";
import { reusableDependencyLinks, statusPath, type GitWorkspaceManager } from "./gitWorkspaceManager.js";
import type { PortableSession } from "./sessionTransfer.js";
interface ActivitySummaryScheduler {
  schedule(sessionId: string): void;
  stop(): void;
}

interface CodexProcessLookup {
  resolveForPane(panePid: number): Promise<CodexProcessInfo | null>;
}

interface CodexMetadataLookup {
  listModels(): Promise<CodexModel[]>;
  effectiveServiceTier(cwd: string): Promise<string | null>;
}

interface ApprovalKeyMap {
  approveOnce: string[];
  approveForPrefix: string[];
  deny: string[];
}

interface SessionManagerStartOptions {
  runInitialTick?: boolean;
}

interface SessionResourceUsageLookup {
  usageForSession(sessionId: string): SessionResourceUsage | null;
}

interface HeavyCommandQueueLookup {
  hasDeferred(workspaceId: string): Promise<boolean>;
  cancelWorkspace(workspaceId: string, reason: string): Promise<void>;
}

interface IngestSessionResult {
  incomplete: boolean;
  progressed: boolean;
}

const MAX_LIVE_INGEST_PASSES_PER_TICK = 8;
const PLAN_ACTION_START_GRACE_MS = 15_000;
const INPUT_DELIVERY_ACK_TIMEOUT_MS = 30_000;

export class SessionManager {
  private discoveryTimer: NodeJS.Timeout | null = null;
  private parserTimer: NodeJS.Timeout | null = null;
  private discoveryRunning = false;
  private ingestRunning = false;
  private readonly answeredPlanMessageIds = new Set<string>();
  private readonly answeredQuestionMessageIds = new Set<string>();
  private readonly pendingPlanActionStatuses = new Map<string, { status: SessionStatus; expiresAtMs: number }>();
  private readonly processingQueuedSessionIds = new Set<string>();
  private readonly liveApprovals = new Map<string, ApprovalRequest>();
  private readonly resolvingRepositoryApprovals = new Map<string, string>();
  private readonly readySessionDiscoveryGeneration = new Map<string, number>();
  private discoveryGeneration = 0;
  private codexFileObservations = new Map<string, { sizeBytes: number; updatedAtMs: number }>();
  private missingIngestCursor = 0;
  private resourceUsageLookup: SessionResourceUsageLookup | null = null;
  private heavyCommandQueue: HeavyCommandQueueLookup | null = null;
  private recoveryRunId: string | null = null;
  private startupRecoveryCandidates: SessionRecoveryCandidate[] = [];
  private readonly restoreLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: AppDatabase,
    private readonly tmux: TmuxAdapter,
    private readonly codexStore: CodexSessionStore,
    private readonly events: EventBus,
    private readonly discoveryIntervalMs: number,
    private readonly parserIntervalMs: number,
    private readonly approvalKeys: ApprovalKeyMap,
    private readonly inputModeCycleKeys: string[],
    private readonly activitySummarizer: ActivitySummaryScheduler | null = null,
    private readonly codexProcessLookup: CodexProcessLookup | null = null,
    private readonly gitWorkspaces: GitWorkspaceManager | null = null,
    private readonly codexHome: string | null = process.env.CODEX_HOME ?? null,
    private readonly gitWorktreeRoot: string | null = null,
    private readonly managedEnvironment: Record<string, string> = {},
    private readonly codexMetadata: CodexMetadataLookup | null = null
  ) {}

  start(options: SessionManagerStartOptions = {}): void {
    if (options.runInitialTick ?? true) {
      this.runBackgroundTask("discovery", () => this.runDiscoverTick());
      this.runBackgroundTask("ingest", () => this.runIngestTick());
    }
    this.discoveryTimer = setInterval(
      () => this.runBackgroundTask("discovery", () => this.runDiscoverTick()),
      this.discoveryIntervalMs
    );
    this.parserTimer = setInterval(
      () => this.runBackgroundTask("ingest", () => this.runIngestTick()),
      this.parserIntervalMs
    );
  }

  async reconcileNow(): Promise<void> {
    await this.runDiscoverTick();
    await this.runIngestTick();
  }

  setResourceUsageLookup(lookup: SessionResourceUsageLookup | null): void {
    this.resourceUsageLookup = lookup;
  }

  setHeavyCommandQueue(lookup: HeavyCommandQueueLookup | null): void {
    this.heavyCommandQueue = lookup;
  }

  async sessionIdForWorkspace(workspaceId: string): Promise<string | null> {
    return (await this.gitWorkspaces?.get(workspaceId))?.sessionId ?? null;
  }

  async resumeHeavyCommand(sessionId: string, message: string): Promise<boolean> {
    const session = await this.db.getSession(sessionId);
    if (!session || session.status === "missing") return false;
    const ready = await this.readyLiveSession(session);
    if (!ready) return false;
    await this.sendRawInput(ready, message);
    const now = nowIso();
    const status = activeInputStatus(ready.inputMode);
    await this.db.setSessionStatus(sessionId, status, now);
    await this.db.addAudit("local", "resume_heavy_command", sessionId, "ok", now);
    this.publish("status.changed", sessionId, { status });
    return true;
  }

  async discoverNow(): Promise<void> {
    await this.runDiscoverTick();
  }

  async prepareStartupRecovery(): Promise<void> {
    const previous = await this.db.getSessionRecoveryRuntime();
    const sessions = await this.db.listSessions(true);
    this.startupRecoveryCandidates = previous && !previous.cleanShutdown
      ? previous.sessionIds
          .map((id) => sessions.find((session) => session.id === id) ?? null)
          .filter((session): session is ManagedSession => Boolean(
            session && !session.archived && session.status !== "missing" && session.codexSessionId
          ))
          .map(recoveryCandidateFromSession)
      : [];
    this.recoveryRunId = eventId();
    await this.db.setSessionRecoveryRuntime({
      runId: this.recoveryRunId,
      cleanShutdown: false,
      updatedAt: nowIso(),
      sessionIds: recoverableLiveSessionIds(sessions)
    });
  }

  async finishStartupRecovery(): Promise<void> {
    if (this.startupRecoveryCandidates.length === 0) return;
    const missing: SessionRecoveryCandidate[] = [];
    for (const candidate of this.startupRecoveryCandidates) {
      const session = await this.db.getSession(candidate.sessionId);
      if (session?.status === "missing" && !session.archived) missing.push(candidate);
    }
    this.startupRecoveryCandidates = [];
    if (missing.length === 0) return;
    const existing = await this.db.getSessionRecoveryIncident();
    const sessions = mergeRecoveryCandidates(existing?.sessions ?? [], missing);
    const incident: SessionRecoveryIncident = {
      id: existing?.id ?? eventId(),
      detectedAt: existing?.detectedAt ?? nowIso(),
      sessions
    };
    await this.db.setSessionRecoveryIncident(incident, nowIso());
  }

  async markCleanShutdown(): Promise<void> {
    if (!this.recoveryRunId) return;
    const sessions = await this.db.listSessions(true);
    await this.db.setSessionRecoveryRuntime({
      runId: this.recoveryRunId,
      cleanShutdown: true,
      updatedAt: nowIso(),
      sessionIds: recoverableLiveSessionIds(sessions)
    });
  }

  async getSessionRecoveryIncident(): Promise<SessionRecoveryIncident | null> {
    const incident = await this.db.getSessionRecoveryIncident();
    if (!incident) return null;
    const sessions = await this.db.listSessions(true);
    const pending = incident.sessions.filter((candidate) => !sessions.some((session) =>
      !session.archived && session.status !== "missing" && recoveryIdentityForSession(session) === sessionHistoryIdentity(candidate)
    ));
    if (pending.length === incident.sessions.length) return incident;
    const next = pending.length > 0 ? { ...incident, sessions: pending } : null;
    await this.db.setSessionRecoveryIncident(next, nowIso());
    return next;
  }

  async restoreSessionRecovery(incidentId: string, sessionIds: string[]): Promise<RestoreSessionRecoveryResponse> {
    const incident = await this.getSessionRecoveryIncident();
    if (!incident || incident.id !== incidentId) throw new SessionRestoreError("Recovery batch is no longer available");
    const selected = new Set(sessionIds);
    const candidates = incident.sessions.filter((candidate) => selected.has(candidate.sessionId));
    if (candidates.length === 0) throw new SessionRestoreError("Select at least one session to restore", 400);
    const results: RestoreSessionRecoveryResult[] = [];
    const failedIds = new Set<string>();
    for (const candidate of candidates) {
      try {
        const restored = await this.restoreSession(candidate.sessionId);
        results.push({
          sourceSessionId: candidate.sessionId,
          status: restored.restored ? "restored" : "reused_live",
          session: restored.session,
          error: null
        });
      } catch (error) {
        failedIds.add(candidate.sessionId);
        results.push({
          sourceSessionId: candidate.sessionId,
          status: "failed",
          session: null,
          error: error instanceof Error ? error.message : "Could not restore session"
        });
      }
    }
    const failures = incident.sessions.filter((candidate) => failedIds.has(candidate.sessionId));
    const current = await this.db.getSessionRecoveryIncident();
    const next = current?.id === incident.id && failures.length > 0 ? { ...incident, sessions: failures } : null;
    await this.db.setSessionRecoveryIncident(next, nowIso());
    return { results, incident: next };
  }

  async dismissSessionRecovery(incidentId: string): Promise<void> {
    const incident = await this.db.getSessionRecoveryIncident();
    if (incident?.id === incidentId) await this.db.setSessionRecoveryIncident(null, nowIso());
  }

  async catchUpIngest(): Promise<void> {
    if (this.ingestRunning) return;
    this.ingestRunning = true;
    try {
      const sessions = await this.listIngestSessions();
      for (const initialSession of sessions) {
        await this.drainIngestSession(initialSession);
      }
    } finally {
      this.ingestRunning = false;
    }
  }

  stop(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.parserTimer) clearInterval(this.parserTimer);
    this.codexStore.stop();
    this.activitySummarizer?.stop();
  }

  async discover(): Promise<void> {
    const discoveryGeneration = ++this.discoveryGeneration;
    const panes = await this.tmux.listPanes();
    const codexFiles = await this.codexStore.listRecent();
    const growingCodexFilePaths = growingCodexFiles(codexFiles, this.codexFileObservations);
    const reconsideredCodexFilePaths = reconsideredCodexFiles(codexFiles, this.codexFileObservations);
    this.codexFileObservations = new Map(
      codexFiles.map((file) => [file.path, { sizeBytes: file.sizeBytes, updatedAtMs: file.updatedAtMs }])
    );
    const codexClaims = new Set<string>();
    const now = nowIso();
    const seen = new Set<string>();
    const paneIds = panes.map(tmuxPaneSessionId);
    const paneCwdCounts = new Map<string, number>();
    for (const pane of panes) paneCwdCounts.set(pane.cwd, (paneCwdCounts.get(pane.cwd) ?? 0) + 1);
    const codexModels = await this.codexMetadata?.listModels().catch(() => []) ?? [];

    for (const [index, pane] of panes.entries()) {
      const sessionId = paneIds[index] ?? tmuxPaneSessionId(pane);
      const currentExisting = await this.db.getSession(sessionId);
      const legacyId = legacyTmuxPaneSessionId(pane);
      const legacyExisting = !currentExisting && legacyId !== sessionId
        ? await this.db.getSession(legacyId)
        : null;
      const migratingLegacy = legacyExisting && sameLivePaneProcess(legacyExisting, pane)
        ? legacyExisting
        : null;
      const existing = currentExisting ?? migratingLegacy;
      const lookupId = existing?.id ?? sessionId;
      const processInfo = await this.codexProcessLookup?.resolveForPane(pane.pid).catch(() => null) ?? null;
      const include = await this.shouldIncludePane(pane, processInfo, existing);
      if (!include) continue;

      const match = await claimCodexFile(
        pane,
        existing,
        codexFiles,
        codexClaims,
        processInfo,
        (lines) => this.tmux.capturePane(pane.paneId, lines, false),
        growingCodexFilePaths,
        reconsideredCodexFilePaths,
        paneCwdCounts.get(pane.cwd) === 1
      );

      seen.add(sessionId);
      let repo = await loadRepoMetadata(pane.cwd);
      const nextCodexSessionId = match?.sessionId ?? null;
      const nextCodexJsonlPath = match?.path ?? null;
      const sourceChanged = Boolean(
        existing &&
          (existing.codexSessionId !== nextCodexSessionId || existing.codexJsonlPath !== nextCodexJsonlPath)
      );
      if (sourceChanged) {
        await this.db.clearSessionTranscript(lookupId);
        if (nextCodexJsonlPath) await this.db.resetParserOffset(parserOffsetKey(lookupId, nextCodexJsonlPath));
      }
      const transcriptSyncing = nextCodexJsonlPath
        ? sourceChanged || !existing || existing.transcriptSyncing === true
        : false;
      const inputMode =
        (await detectLiveCollaborationMode(pane, (paneId, lines) => this.tmux.capturePane(paneId, lines, false))) ??
        existing?.inputMode ??
        "default";
      const rawInferredStatus = await inferStatus(pane, existing?.status, (paneId, lines) => this.tmux.capturePane(paneId, lines, false));
      const latestMessage = await this.db.latestMessage(lookupId);
      const liveApprovalPrompt =
        rawInferredStatus !== "approval"
          ? null
          : latestMessage?.type === "approval_request"
            ? await this.capturePaneApprovalPrompt(pane)
            : await this.corroboratedLiveApproval(pane, latestMessage);
      const inferredStatus =
        rawInferredStatus === "approval" && latestMessage?.type !== "approval_request" && !liveApprovalPrompt
          ? rejectedApprovalFallbackStatus(pane, existing?.status)
          : rawInferredStatus;
      let latestUserMessage = await this.db.latestUserMessage(lookupId);
      const latestTurnLifecycleMessage = await this.db.latestTurnLifecycleMessage(lookupId);
      latestUserMessage = await this.reconcileInputDeliveryState(
        latestUserMessage,
        latestTurnLifecycleMessage,
        inferredStatus
      );
      const latestQuestionMessage = await this.db.latestQuestionMessage(lookupId);
      const status = resolveSessionStatus(
        inferredStatus,
        inputMode,
        latestQuestionMessage,
        await this.latestQuestionAnswerMessage(lookupId, latestQuestionMessage),
        await this.db.latestPlanReadyMessage(lookupId),
        latestUserMessage,
        latestTurnLifecycleMessage,
        this.pendingPlanActionStatus(lookupId),
        this.answeredPlanMessageIds,
        this.answeredQuestionMessageIds
      );
      const recoveredFromStartupError = Boolean(existing?.startupError) && status !== "startup_failed" && status !== "unknown";
      const startupError = sourceChanged || recoveredFromStartupError ? null : existing?.startupError ?? null;
      const effectiveStatus = startupError ? "startup_failed" : status;
      const jsonlModelSettings = match ? await readLatestCodexModelSettings(match) : null;
      const paneModelSettings = await readLiveCodexModelSettings(
        pane,
        (paneId, lines) => this.tmux.capturePane(paneId, lines, false)
      );
      const liveModelSettings = mergeModelSettings(jsonlModelSettings, paneModelSettings);
      const models = mergeSessionModels(existing?.models, inputMode, liveModelSettings);
      const activeModel = activeSessionModel(models, inputMode);
      const discoveredFastModeAvailable = codexFastModeAvailable(codexModels, activeModel);
      const fastModeAvailable = discoveredFastModeAvailable ?? (sourceChanged ? null : existing?.fastModeAvailable ?? null);
      const observedFastMode = nextCodexJsonlPath ? await readLatestCodexFastMode(nextCodexJsonlPath) : null;
      const storedFastMode = sourceChanged ? null : existing?.fastMode ?? null;
      const configuredFastMode = observedFastMode === null && storedFastMode === null
        ? serviceTierFastMode(await this.codexMetadata?.effectiveServiceTier(pane.cwd).catch(() => null) ?? null)
        : null;
      const fastMode = observedFastMode ?? storedFastMode ?? configuredFastMode;
      const storedGitWorkspace = await this.gitWorkspaces?.getBySession(lookupId) ?? null;
      if (storedGitWorkspace) repo = await loadRepoMetadata(storedGitWorkspace.summary.entryPath);
      const refreshedGitWorkspace = storedGitWorkspace ? await this.gitWorkspaces?.refresh(storedGitWorkspace) : null;
      const activeGitWorkspace = refreshedGitWorkspace?.summary ?? existing?.gitWorkspace ?? null;
      const projectedStatus =
        !startupError && isInputReadyStatus(effectiveStatus) && activeGitWorkspace && await this.heavyCommandQueue?.hasDeferred(activeGitWorkspace.id)
          ? "queued"
          : effectiveStatus;
      const session: ManagedSession = {
        id: sessionId,
        tmux: pane,
        repo,
        codexSessionId: nextCodexSessionId,
        codexJsonlPath: nextCodexJsonlPath,
        discoveryConfidence: match ? "high" : looksLikeCodexPane(pane) ? "medium" : "low",
        status: projectedStatus,
        initializing: existing?.initializing === true,
        startupError,
        lastActivityAt: sourceChanged ? null : existing?.lastActivityAt ?? null,
        preview: sourceChanged ? "" : existing?.preview ?? "",
        recentUserPrompts: sourceChanged ? [] : existing?.recentUserPrompts ?? [],
        activitySummary: sourceChanged ? null : existing?.activitySummary ?? null,
        activitySummaryGeneratedAt: sourceChanged ? null : existing?.activitySummaryGeneratedAt ?? null,
        activitySummarySourceSequence: sourceChanged ? null : existing?.activitySummarySourceSequence ?? null,
        inputMode,
        models,
        fastMode,
        fastModeAvailable,
        transcriptSize: sourceChanged ? 0 : existing?.transcriptSize ?? 0,
        transcriptSyncing,
        unreadCount: sourceChanged ? 0 : existing?.unreadCount ?? 0,
        pinned: existing?.pinned ?? false,
        archived: existing?.archived ?? false,
        gitWorkspace: activeGitWorkspace,
        forkedFrom: existing?.forkedFrom ?? null
      };

      if (effectiveStatus === "approval" && liveApprovalPrompt) {
        this.liveApprovals.set(sessionId, materializeInteractiveApproval(session, liveApprovalPrompt, latestMessage));
      } else {
        this.liveApprovals.delete(sessionId);
      }
      if (!liveApprovalPrompt) this.resolvingRepositoryApprovals.delete(sessionId);

      const changed = !existing || sessionChanged(existing, session);
      if (migratingLegacy) {
        const parserOffsetMove = nextCodexJsonlPath
          ? {
              from: parserOffsetKey(migratingLegacy.id, nextCodexJsonlPath),
              to: parserOffsetKey(session.id, nextCodexJsonlPath)
            }
          : null;
        await this.db.rekeySession(migratingLegacy.id, session, parserOffsetMove, now);
        this.liveApprovals.delete(migratingLegacy.id);
        this.resolvingRepositoryApprovals.delete(migratingLegacy.id);
      } else {
        await this.db.upsertSession(session, now, true);
      }
      await this.recordTouchedRepository(session, now);
      if (changed) this.publish("session.updated", session.id, await this.db.getSession(session.id) ?? session);
      await this.processQueuedInputs(session.id);
      if (liveApprovalPrompt) {
        await this.resolveRememberedRepositoryApproval(session, liveApprovalPrompt);
      }
    }

    for (const session of await this.db.listSessions(true)) {
      if (!seen.has(session.id) && !session.initializing && session.status !== "missing") {
        const readyGeneration = this.readySessionDiscoveryGeneration.get(session.id);
        if (readyGeneration !== undefined && discoveryGeneration <= readyGeneration) continue;
        this.readySessionDiscoveryGeneration.delete(session.id);
        if (session.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(session.gitWorkspace.id, "owning session is missing");
        this.liveApprovals.delete(session.id);
        await this.db.setSessionStatus(session.id, "missing", now);
        this.publish("status.changed", session.id, { status: "missing" });
      }
    }
    await this.recordRecoveryRoster();
  }

  private async recordRecoveryRoster(): Promise<void> {
    if (!this.recoveryRunId) return;
    const sessions = await this.db.listSessions(true);
    await this.db.setSessionRecoveryRuntime({
      runId: this.recoveryRunId,
      cleanShutdown: false,
      updatedAt: nowIso(),
      sessionIds: recoverableLiveSessionIds(sessions)
    });
  }

  private async runDiscoverTick(): Promise<void> {
    if (this.discoveryRunning) return;
    this.discoveryRunning = true;
    try {
      await this.discover();
    } finally {
      this.discoveryRunning = false;
    }
  }

  async ingest(): Promise<void> {
    const sessions = await this.listIngestSessions();
    const live = sessions.filter((session) => session.status !== "missing");
    const missing = sessions.filter((session) => session.status === "missing");
    for (const session of live) await this.drainIngestSession(session, MAX_LIVE_INGEST_PASSES_PER_TICK);
    const missingIndex = missing.length > 0 ? this.missingIngestCursor % missing.length : -1;
    const missingSession = missingIndex >= 0 ? missing[missingIndex] : null;
    if (missing.length > 0) this.missingIngestCursor = (missingIndex + 1) % missing.length;
    if (missingSession) await this.ingestSession(missingSession);
  }

  private async runIngestTick(): Promise<void> {
    if (this.ingestRunning) return;
    this.ingestRunning = true;
    try {
      await this.ingest();
    } finally {
      this.ingestRunning = false;
    }
  }

  private runBackgroundTask(name: "discovery" | "ingest", task: () => Promise<void>): void {
    void task().catch((error) => {
      console.error(`Muxpilot ${name} background task failed`, error);
    });
  }

  private async listIngestSessions(): Promise<ManagedSession[]> {
    const sessions = (await this.db.listSessions(true)).filter((session) => session.codexJsonlPath && !session.archived);
    const offsets = await this.db.listParserOffsets();
    const targets = await Promise.all(
      sessions.map(async (session): Promise<IngestTarget | null> => {
        const source = session.codexJsonlPath!;
        const metadata = await sessionSourceMetadata(session);
        const offset = offsets[parserOffsetKey(session.id, source)];
        const needsIngest =
          session.transcriptSyncing ||
          offset === undefined ||
          metadata.sizeBytes === null ||
          metadata.sizeBytes !== offset;
        if (!needsIngest || (metadata.sizeBytes === null && session.status === "missing" && !session.transcriptSyncing)) return null;
        return { session, sourceUpdatedAtMs: metadata.updatedAtMs };
      })
    );
    return targets
      .filter((target): target is IngestTarget => Boolean(target))
      .sort(compareIngestTargets)
      .map((target) => target.session);
  }

  private async drainIngestSession(initialSession: ManagedSession, maxPasses = Number.POSITIVE_INFINITY): Promise<void> {
    let session: ManagedSession | null = initialSession;
    let passes = 0;
    while (session && passes < maxPasses) {
      passes += 1;
      const result = await this.ingestSession(session);
      if (!result.incomplete || !result.progressed) break;
      const refreshed = await this.db.getSession(session.id);
      session =
        refreshed && refreshed.codexJsonlPath === initialSession.codexJsonlPath && !refreshed.archived
          ? refreshed
          : null;
    }
  }

  private async ingestSession(session: ManagedSession): Promise<IngestSessionResult> {
    const source = session.codexJsonlPath;
    if (!source) return { incomplete: false, progressed: false };

    try {
      const offsetKey = parserOffsetKey(session.id, source);
      const hasOffset = await this.db.hasParserOffset(offsetKey);
      if (!hasOffset && (await this.db.latestMessageSequence(session.id)) > 0) {
        await this.db.clearSessionTranscript(session.id);
      }
      const offset = await this.db.getParserOffset(offsetKey);
      const result = await parseCodexJsonl(source, offset);
      for (const notice of result.notices) {
        const message: ChatMessage = {
          id: stableId(`${session.id}:parser-notice:${source}:${offset}:${notice}`),
          sessionId: session.id,
          sequence: await this.db.nextSequence(session.id),
          type: "parser_notice",
          role: "system",
          timestamp: nowIso(),
          text: notice,
          payload: { source, offset }
        };
        if (await this.db.appendMessage(message)) this.publish("message.appended", session.id, message);
      }
      if (result.pendingSkillNames.length > 0) {
        const previousUserMessage = await this.db.latestUserMessage(session.id);
        if (previousUserMessage) {
          const text = appendSkillNamesForDisplay(previousUserMessage.text, result.pendingSkillNames);
          if (text !== previousUserMessage.text) {
            const updatedMessage = await this.db.updateMessageText(previousUserMessage, text);
            if (updatedMessage) this.publish("message.appended", session.id, updatedMessage);
          }
        }
      }
      for (const partial of result.messages) {
        const message: ChatMessage = withQuestionCountdown({
          ...partial,
          id: stableId(`${session.id}:${source}:${partial.id}`),
          sessionId: session.id,
          sequence: await this.db.nextSequence(session.id)
        });
        const appended = await this.db.appendMessage(message);
        if (isTurnCompletionMessage(message)) this.pendingPlanActionStatuses.delete(session.id);
        if (appended) {
          this.publish("message.appended", session.id, message);
          if (message.role === "user") this.activitySummarizer?.schedule(session.id);
          if (!session.transcriptSyncing && message.type === "approval_request") {
            const now = nowIso();
            await this.db.setSessionStatus(session.id, "approval", now);
            this.publish("status.changed", session.id, { status: "approval" });
          }
          if (!session.transcriptSyncing && message.type === "question_request") {
            const now = nowIso();
            await this.db.setSessionStatus(session.id, "question", now);
            this.publish("status.changed", session.id, { status: "question" });
          }
          if (!session.transcriptSyncing && isPlanReadyMessage(message)) {
            const now = nowIso();
            await this.db.setSessionStatus(session.id, "plan_ready", now);
            this.publish("status.changed", session.id, { status: "plan_ready" });
          }
        }
        if (message.role === "user") {
          const messageMode = collaborationModeFromMessage(message);
          if (messageMode) {
            const current = await this.db.getSession(session.id);
            if (current?.inputMode !== messageMode) {
              await this.db.setSessionInputMode(session.id, messageMode, nowIso());
              this.publish("session.updated", session.id, await this.db.getSession(session.id));
            }
          }
        }
      }
      if ((await this.db.deleteEchoedSentQueuedInputs(session.id)) > 0) {
        this.publish("queue.updated", session.id, { queuedInputs: await this.db.listQueuedInputs(session.id) });
      }
      await this.processQueuedInputs(session.id);
      const currentSession = await this.db.getSession(session.id);
      if (!currentSession || currentSession.codexJsonlPath !== source) {
        return { incomplete: false, progressed: false };
      }
      if (!hasOffset || result.nextOffset !== offset) {
        await this.db.setParserOffset(offsetKey, result.nextOffset, PARSER_VERSION, nowIso());
      }
      if (result.complete && currentSession.transcriptSyncing) {
        const latestQuestionMessage = await this.db.latestQuestionMessage(session.id);
        const latestUserMessage = await this.db.latestUserMessage(session.id);
        const status = resolveSessionStatus(
          currentSession.status,
          currentSession.inputMode,
          latestQuestionMessage,
          await this.latestQuestionAnswerMessage(session.id, latestQuestionMessage),
          await this.db.latestPlanReadyMessage(session.id),
          latestUserMessage,
          await this.db.latestTurnLifecycleMessage(session.id),
          this.pendingPlanActionStatus(session.id),
          this.answeredPlanMessageIds,
          this.answeredQuestionMessageIds
        );
        const syncedSession = { ...currentSession, status, transcriptSyncing: false };
        await this.db.upsertSession(syncedSession, nowIso());
        this.publish("session.updated", session.id, syncedSession);
      }
      return { incomplete: !result.complete, progressed: result.nextOffset > offset };
    } catch (error) {
      const currentSession = await this.db.getSession(session.id);
      if (!currentSession || currentSession.codexJsonlPath !== source) {
        return { incomplete: false, progressed: false };
      }
      const text = error instanceof Error ? error.message : String(error);
      const message: ChatMessage = {
        id: stableId(`${session.id}:parser:${text}:${Date.now()}`),
        sessionId: session.id,
        sequence: await this.db.nextSequence(session.id),
        type: "parser_notice",
        role: "system",
        timestamp: nowIso(),
        text: `Parser error: ${text}`,
        payload: { error: text }
      };
      if (await this.db.appendMessage(message)) this.publish("message.appended", session.id, message);
      return { incomplete: false, progressed: false };
    }
  }

  listSessions(includeArchived = false, includeMissing = true): Promise<ManagedSession[]> {
    const result = this.db.listSessions(true, includeMissing) as Promise<ManagedSession[]> | ManagedSession[];
    const decorate = (allSessions: ManagedSession[]) => {
      const sessions = includeArchived ? allSessions : allSessions.filter((session) => !session.archived);
      return sessions.map((session) => this.decorateSession(session, allSessions));
    };
    return (Array.isArray(result) ? decorate(result) : result.then(decorate)) as Promise<ManagedSession[]>;
  }

  getSession(sessionId: string): Promise<ManagedSession | null> {
    const result = this.db.getSession(sessionId) as Promise<ManagedSession | null> | ManagedSession | null;
    const decorate = (session: ManagedSession | null): Promise<ManagedSession | null> | ManagedSession | null => {
      if (!session) return null;
      if (!session.forkedFrom) return this.decorateSession(session, [session]);
      const allSessions = this.db.listSessions(true) as Promise<ManagedSession[]> | ManagedSession[];
      return Array.isArray(allSessions)
        ? this.decorateSession(session, allSessions)
        : allSessions.then((sessions) => this.decorateSession(session, sessions));
    };
    return (isPromiseLike(result) ? result.then(decorate) : decorate(result)) as Promise<ManagedSession | null>;
  }

  listQueuedInputs(sessionId: string): Promise<QueuedInput[]> {
    return this.db.listQueuedInputs(sessionId);
  }

  private withResourceUsage(session: ManagedSession): ManagedSession {
    if (!this.resourceUsageLookup) return session;
    return { ...session, resourceUsage: this.resourceUsageLookup.usageForSession(session.id) };
  }

  private decorateSession(session: ManagedSession, allSessions: ManagedSession[]): ManagedSession {
    const origin = session.forkedFrom;
    const source = origin
      ? preferredForkSource(allSessions.filter((candidate) => candidate.codexSessionId === origin.codexSessionId))
      : null;
    const withOrigin = origin
      ? {
          ...session,
          forkedFrom: {
            ...origin,
            sessionId: source?.id ?? null,
            sessionName: source ? sessionName(source) : origin.sessionName
          }
        }
      : session;
    return this.withResourceUsage(withOrigin);
  }

  async listSessionHistory(query: string, limit: number): Promise<SessionHistoryResult[]> {
    const results = await this.db.listSessionHistory(query, limit * 2);
    return collapseHistoryByIdentity(results, limit);
  }

  async restoreSession(sessionId: string): Promise<{ session: ManagedSession; restored: boolean }> {
    const initial = await this.db.getSession(sessionId);
    if (!initial) throw new SessionNotFoundError("Session not found");
    if (!initial.codexSessionId) throw new SessionRestoreError("Session does not have a Codex session id to resume");
    const key = recoveryIdentityForSession(initial);
    const prior = this.restoreLocks.get(key) ?? Promise.resolve();
    const restore = prior.catch(() => undefined).then(() => this.restoreSessionUnlocked(sessionId, key));
    this.restoreLocks.set(key, restore);
    try {
      const result = await restore;
      await this.recordRecoveryRoster();
      return result;
    } finally {
      if (this.restoreLocks.get(key) === restore) this.restoreLocks.delete(key);
    }
  }

  private async restoreSessionUnlocked(sessionId: string, restoreIdentity: string): Promise<{ session: ManagedSession; restored: boolean }> {
    const source = await this.db.getSession(sessionId) ??
      (await this.db.listSessions(true)).find((session) => recoveryIdentityForSession(session) === restoreIdentity) ?? null;
    if (!source) throw new SessionNotFoundError("Session not found");
    if (!source.codexSessionId) throw new SessionRestoreError("Session does not have a Codex session id to resume");

    const live = await this.findLiveSessionByRecoveryIdentity(restoreIdentity);
    if (live) {
      if (live.archived) await this.db.markSessionArchived(live.id, false, nowIso());
      const session = requireSession(await this.db.getSession(live.id));
      this.publish("session.updated", session.id, session);
      return { session, restored: false };
    }

    const storedGitWorkspace = await this.gitWorkspaces?.getBySession(source.id) ?? null;
    const cwd = storedGitWorkspace
      ? await this.gitWorkspaces!.ensureControlPath(storedGitWorkspace)
      : await requireExistingDirectory(source.repo.root ?? source.tmux.cwd);
    const launchWorkspace = storedGitWorkspace
      ? await this.gitWorkspaces!.get(storedGitWorkspace.id) ?? storedGitWorkspace
      : null;
    const name = restoreSessionName(source);
    const launch = await this.tmux.createCodexResumeWindowInMuxpilotSession(
      cwd,
      name,
      source.codexSessionId,
      launchWorkspace
        ? managedCodexLaunchOptions(launchWorkspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment)
        : { environment: this.managedEnvironment }
    );
    const session = await this.rebindRestoredSession(source, launch.pane);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "restore_session", source.id, "ok", nowIso());
    this.publish("session.updated", session.id, session);
    return { session, restored: true };
  }

  async importPortableSession(
    portable: PortableSession,
    transcript: Buffer,
    mapping: SessionTransferImportMapping
  ): Promise<SessionTransferImportResult> {
    const destination = await requireExistingDirectory(mapping.destinationCwd);
    const existing = (await this.db.listSessions(true)).find((session) => session.codexSessionId === portable.codexSessionId) ?? null;
    let selectedTranscript = transcript;
    let keptExisting = false;
    if (existing) {
      const live = await this.findLiveSessionByCodexSessionId(portable.codexSessionId);
      if (live) return {
        codexSessionId: portable.codexSessionId,
        sessionName: portable.sessionName,
        status: "reused_live",
        sessionId: live.id,
        error: null
      };
      const existingTranscript = existing.codexJsonlPath ? await readFile(existing.codexJsonlPath).catch(() => null) : null;
      if (existingTranscript && compareTranscripts(existingTranscript, transcript) >= 0) {
        selectedTranscript = completeTranscriptPrefix(existingTranscript);
        keptExisting = true;
      }
      await this.db.markSessionArchived(existing.id, true, nowIso());
    }

    if (!this.codexHome) throw new SessionRestoreError("Codex home is unavailable");
    const transcriptPath = join(this.codexHome, "sessions", "imported", `rollout-imported-${portable.codexSessionId}.jsonl`);
    await atomicWrite(transcriptPath, selectedTranscript);
    const placeholderId = `imported:${eventId()}`;
    const repo = await loadRepoMetadata(destination);
    const syntheticPane: TmuxPane = {
      sessionId: "muxpilot",
      sessionName: "muxpilot",
      windowId: "@imported",
      windowIndex: -1,
      windowName: portable.sessionName,
      paneId: `%imported-${portable.codexSessionId}`,
      paneIndex: -1,
      paneActive: false,
      cwd: destination,
      currentCommand: "codex",
      title: portable.sessionName,
      pid: 0,
      size: "0x0"
    };
    const session: ManagedSession = {
      id: placeholderId,
      tmux: syntheticPane,
      repo,
      codexSessionId: portable.codexSessionId,
      codexJsonlPath: transcriptPath,
      discoveryConfidence: "high",
      status: "missing",
      lastActivityAt: portable.lastActivityAt,
      preview: "",
      recentUserPrompts: [],
      activitySummary: null,
      activitySummaryGeneratedAt: null,
      activitySummarySourceSequence: null,
      inputMode: portable.inputMode,
      models: portable.models,
      fastMode: portable.fastMode ?? null,
      fastModeAvailable: null,
      transcriptSize: 0,
      unreadCount: 0,
      pinned: portable.pinned,
      archived: false,
      forkedFrom: portable.forkedFrom ?? null,
      gitWorkspace: null
    };
    await this.db.upsertSession(session, nowIso());

    if (portable.workspaceMode === "git") {
      if (!this.gitWorkspaces) throw new SessionRestoreError("Managed Git workspaces are unavailable");
      const targetBranch = portable.gitBranchId ? portable.targetBranch : mapping.targetBranch ?? portable.targetBranch;
      if (!targetBranch) throw new SessionRestoreError("A local target branch is required for the imported Git session");
      const workspace = await this.gitWorkspaces.provision({ sessionName: portable.sessionName, entryPath: destination, targetBranch });
      await this.gitWorkspaces.bind(workspace.id, placeholderId);
      session.gitWorkspace = workspace.summary;
      await this.db.upsertSession(session, nowIso());
    }

    await this.ingestSession(session);
    const restored = await this.restoreSession(placeholderId);
    return {
      codexSessionId: portable.codexSessionId,
      sessionName: portable.sessionName,
      status: keptExisting ? "kept_existing" : "resumed",
      sessionId: restored.session.id,
      error: null
    };
  }

  async validatePortableMapping(portable: PortableSession, mapping: SessionTransferImportMapping): Promise<void> {
    const destination = await requireExistingDirectory(mapping.destinationCwd);
    if (portable.workspaceMode !== "git") return;
    if (!this.gitWorkspaces) throw new SessionRestoreError("Managed Git workspaces are unavailable");
    const targetBranch = portable.gitBranchId ? portable.targetBranch : mapping.targetBranch ?? portable.targetBranch;
    if (!targetBranch) throw new SessionRestoreError(`A local target branch is required for '${portable.sessionName}'`);
    const probe = await this.gitWorkspaces.probe(destination);
    if (!probe.isGit || !probe.repoRoot) throw new SessionRestoreError(`Destination for '${portable.sessionName}' is not a Git repository`);
    if (!probe.localBranches.includes(targetBranch)) throw new SessionRestoreError(`Local target branch '${targetBranch}' does not exist for '${portable.sessionName}'`);
  }

  async enqueueInput(sessionId: string, text: string, mode?: CollaborationMode): Promise<QueuedInput> {
    const session = requireSession(await this.db.getSession(sessionId));
    if (session.status === "input_failed") {
      throw new QueuedInputError("Retry or dismiss the failed input before queuing another message");
    }
    const now = nowIso();
    const input: QueuedInput = {
      id: eventId(),
      sessionId,
      text,
      mode: mode ?? session.inputMode,
      status: "queued",
      error: null,
      codexSessionId: session.codexSessionId,
      codexJsonlPath: session.codexJsonlPath,
      createdAt: now,
      updatedAt: now,
      sentAt: null
    };
    await this.db.appendQueuedInput(input);
    await this.db.addAudit("local", "queue_input", sessionId, "ok", now);
    this.publish("queue.updated", sessionId, { queuedInputs: await this.db.listQueuedInputs(sessionId) });
    void this.processQueuedInputs(sessionId);
    return input;
  }

  async updateQueuedInput(sessionId: string, queuedInputId: string, text: string, mode?: CollaborationMode): Promise<QueuedInput> {
    const current = await this.db.getQueuedInput(sessionId, queuedInputId);
    if (!current) throw new QueuedInputError("Queued input not found", 404);
    if (current.status === "sending") throw new QueuedInputError("Queued input is already sending");
    if (current.status === "sent") throw new QueuedInputError("Queued input has already been sent");
    const updated: QueuedInput = {
      ...current,
      text,
      mode: mode ?? current.mode,
      status: "queued",
      error: null,
      updatedAt: nowIso(),
      sentAt: null
    };
    await this.db.updateQueuedInput(updated);
    this.publish("queue.updated", sessionId, { queuedInputs: await this.db.listQueuedInputs(sessionId) });
    void this.processQueuedInputs(sessionId);
    return updated;
  }

  async deleteQueuedInput(sessionId: string, queuedInputId: string): Promise<void> {
    const current = await this.db.getQueuedInput(sessionId, queuedInputId);
    if (!current) return;
    if (current.status === "sending") throw new QueuedInputError("Queued input is already sending");
    await this.db.deleteQueuedInput(sessionId, queuedInputId);
    this.publish("queue.updated", sessionId, { queuedInputs: await this.db.listQueuedInputs(sessionId) });
  }

  listMessages(sessionId: string, afterSequence: number): Promise<ChatMessage[]> {
    return this.db.listMessages(sessionId, afterSequence);
  }

  async listRecentMessages(sessionId: string, limit: number): Promise<TranscriptPageResponse> {
    return this.withTranscriptSource(sessionId, await this.db.listRecentMessages(sessionId, limit));
  }

  async listActiveTailMessages(sessionId: string, fallbackLimit: number): Promise<TranscriptPageResponse> {
    return this.withTranscriptSource(sessionId, await this.db.listActiveTailMessages(sessionId, fallbackLimit));
  }

  async listEarliestMessages(sessionId: string, limit: number): Promise<TranscriptPageResponse> {
    return this.withTranscriptSource(sessionId, await this.db.listEarliestMessages(sessionId, limit));
  }

  async listMessagesBefore(sessionId: string, beforeSequence: number, limit: number): Promise<TranscriptPageResponse> {
    return this.withTranscriptSource(sessionId, await this.db.listMessagesBefore(sessionId, beforeSequence, limit));
  }

  async listMessagesAfterPage(sessionId: string, afterSequence: number, limit: number): Promise<TranscriptPageResponse> {
    return this.withTranscriptSource(sessionId, await this.db.listMessagesAfterPage(sessionId, afterSequence, limit));
  }

  async listMessagesAround(sessionId: string, aroundSequence: number, limit: number): Promise<TranscriptPageResponse> {
    return this.withTranscriptSource(sessionId, await this.db.listMessagesAround(sessionId, aroundSequence, limit));
  }

  async listMessageRange(sessionId: string, fromSequence: number, toSequence: number): Promise<TranscriptPageResponse> {
    return this.withTranscriptSource(sessionId, await this.db.listMessageRange(sessionId, fromSequence, toSequence));
  }

  async searchMessages(sessionId: string, query: string, limit: number): Promise<TranscriptSearchResponse> {
    return this.withTranscriptSource(sessionId, await this.db.searchMessages(sessionId, query, limit));
  }

  async getPendingApproval(sessionId: string): Promise<ApprovalRequest | null> {
    const session = await this.db.getSession(sessionId);
    if (!session || session.status === "missing") return null;
    const interactive = await this.captureInteractiveApprovalPrompt(session);
    if (interactive) {
      const approval = materializeInteractiveApproval(session, interactive, await this.db.latestMessage(sessionId));
      this.liveApprovals.set(sessionId, approval);
      if (session.status !== "approval") {
        const now = nowIso();
        await this.db.setSessionStatus(sessionId, "approval", now);
        this.publish("status.changed", sessionId, { status: "approval" });
        this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
      }
      return this.repositoryScopedApproval(sessionId, approval);
    }
    if (session.status !== "approval") return null;
    if (!(await this.isApprovalGateVisible(session))) {
      this.liveApprovals.delete(sessionId);
      return null;
    }
    const liveApproval = this.liveApprovals.get(sessionId);
    if (liveApproval) return this.repositoryScopedApproval(sessionId, liveApproval);
    const message = await this.db.latestApprovalMessage(sessionId);
    if (!message) return null;
    const approval = materializeApproval(message);
    return approval ? this.repositoryScopedApproval(sessionId, approval) : null;
  }

  private async repositoryScopedApproval(sessionId: string, approval: ApprovalRequest): Promise<ApprovalRequest> {
    if (!approval.prefixRule?.length || !(await this.db.getGitWorkspaceBySession(sessionId))) return approval;
    return {
      ...approval,
      options: approval.options.map((option) =>
        option.decision === "approve_for_prefix"
          ? { ...option, label: "Allow for repository", description: "Remember this prefix for this Git repository." }
          : option
      )
    };
  }

  async getPendingQuestion(sessionId: string): Promise<QuestionRequest | null> {
    const session = await this.db.getSession(sessionId);
    if (!session || session.status === "missing") return null;
    const latestQuestionMessage = await this.db.latestQuestionMessage(sessionId);
    const message = activeQuestionMessage(
      latestQuestionMessage,
      await this.latestQuestionAnswerMessage(sessionId, latestQuestionMessage),
      await this.db.latestUserMessage(sessionId),
      await this.db.latestPlanReadyMessage(sessionId),
      this.answeredPlanMessageIds,
      this.answeredQuestionMessageIds
    );
    if (!message) return null;
    return materializeQuestion(message);
  }

  async sendInput(
    sessionId: string,
    text: string,
    mode?: CollaborationMode
  ): Promise<{ session: ManagedSession; message: ChatMessage } | { queuedInput: QueuedInput }> {
    const session = requireSession(await this.db.getSession(sessionId));
    if (session.status === "input_failed") {
      throw new InputDeliveryError("Retry or dismiss the failed input before sending another message");
    }
    if (await this.shouldQueueInput(session, text)) {
      return { queuedInput: await this.enqueueInput(sessionId, text, mode) };
    }
    const targetMode = mode ?? session.inputMode;
    const liveSession = await this.ensureInputMode(session, targetMode);
    await this.sendRawInput(liveSession, text);
    const latestPlanMessage = await this.db.latestPlanReadyMessage(sessionId);
    if (latestPlanMessage && isPlanActionInput(text)) {
      this.answeredPlanMessageIds.add(latestPlanMessage.id);
    }
    const now = nowIso();
    const message = await this.recordSubmittedInput(session, text, targetMode, now);
    await this.db.setSessionInputMode(sessionId, targetMode, now);
    const status = activeInputStatus(targetMode);
    await this.db.setSessionStatus(sessionId, status, now);
    await this.db.addAudit("local", `send_input:${targetMode}`, sessionId, "ok", now);
    const updatedSession = requireSession(await this.db.getSession(sessionId));
    this.publish("message.appended", sessionId, message);
    this.publish("status.changed", sessionId, { status });
    this.publish("session.updated", sessionId, updatedSession);
    return { session: updatedSession, message };
  }

  private async shouldQueueInput(session: ManagedSession, text: string): Promise<boolean> {
    if (session.gitWorkspace && await this.heavyCommandQueue?.hasDeferred(session.gitWorkspace.id)) return true;
    if (isPlanActionInput(text)) return false;
    const queuedInputs = await this.db.listQueuedInputs(session.id);
    if (queuedInputs.length > 0) return true;
    return !isInputReadyStatus(session.status);
  }

  private async sendRawInput(session: ManagedSession, text: string): Promise<void> {
    const pane = await this.livePane(session);
    await this.tmux.sendInput(pane.paneId, codexTerminalUserText(text));
  }

  private async recordSubmittedInput(
    session: ManagedSession,
    text: string,
    mode: CollaborationMode,
    timestamp: string
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: eventId(),
      sessionId: session.id,
      sequence: await this.db.nextSequence(session.id),
      type: "user",
      role: "user",
      timestamp,
      text,
      payload: {
        collaborationMode: mode,
        muxpilotSubmission: {
          codexSessionId: session.codexSessionId,
          codexJsonlPath: session.codexJsonlPath,
          state: "pending",
          attemptCount: 1,
          lastAttemptAt: timestamp,
          failureReason: null
        }
      }
    };
    if (!await this.db.appendMessage(message)) throw new Error("Could not persist submitted input");
    return message;
  }

  async resolveApproval(sessionId: string, request: ResolveApprovalRequest): Promise<void> {
    const session = requireSession(await this.db.getSession(sessionId));
    const approval = await this.getPendingApproval(sessionId);
    if (!approval) throw new ApprovalResolutionError("No pending approval for this session");
    if (!approval.options.some((option) => option.decision === request.decision)) {
      throw new ApprovalResolutionError("This choice is not available for the pending approval");
    }
    if (request.decision === "approve_for_prefix" && !approval.prefixRule?.length) {
      throw new ApprovalResolutionError("This approval request does not include a persistent prefix rule");
    }
    const workspace = await this.db.getGitWorkspaceBySession(sessionId);
    const codexDecision = request.decision === "approve_for_prefix" && workspace ? "approve_once" : request.decision;

    const interactive = await this.captureInteractiveApprovalPrompt(session);
    let keys: string[];
    if (interactive) {
      if (!interactiveApprovalMatches(approval, interactive)) {
        throw new ApprovalResolutionError("The pending approval changed before this choice was submitted");
      }
      if (!interactive.options.some((option) => option.decision === codexDecision)) {
        throw new ApprovalResolutionError("This choice is no longer available for the pending approval");
      }
      const interactiveKeys =
        codexDecision === "deny" ? this.approvalKeys.deny : interactiveApprovalKeys(interactive, codexDecision);
      if (!interactiveKeys) throw new ApprovalResolutionError("Could not select this approval choice");
      keys = interactiveKeys;
    } else {
      const active = await this.isApprovalGateVisible(session);
      if (!active) throw new ApprovalResolutionError("The tmux pane is not showing an approval gate");
      keys = this.keysForDecision(codexDecision);
    }

    const now = nowIso();
    await this.tmux.sendKeys(session.tmux.paneId, keys);
    if (request.decision === "approve_for_prefix" && approval.prefixRule?.length) {
      if (workspace) {
        await this.db.addRepositoryApprovalRule(
          workspace.commonGitDir,
          normalizeRepositoryApprovalPrefix(approval.prefixRule, workspace),
          now
        );
      }
    }
    await this.db.setSessionStatus(sessionId, "waiting", now);
    await this.db.addAudit("local", `approval:${request.decision}`, sessionId, "ok", now);
    this.publish("status.changed", sessionId, { status: "waiting" });
    this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
  }

  private async resolveRememberedRepositoryApproval(
    session: ManagedSession,
    prompt: InteractiveApprovalPrompt
  ): Promise<void> {
    if (!prompt.prefixRule?.length || !prompt.options.some((option) => option.decision === "approve_once")) return;
    const signature = JSON.stringify(prompt.prefixRule);
    if (this.resolvingRepositoryApprovals.get(session.id) === signature) return;
    const workspace = await this.db.getGitWorkspaceBySession(session.id);
    if (
      !workspace ||
      !(await this.db.hasRepositoryApprovalRule(
        workspace.commonGitDir,
        normalizeRepositoryApprovalPrefix(prompt.prefixRule, workspace)
      ))
    ) return;
    const keys = interactiveApprovalKeys(prompt, "approve_once");
    if (!keys) return;
    await this.tmux.sendKeys(session.tmux.paneId, keys);
    this.resolvingRepositoryApprovals.set(session.id, signature);
    const now = nowIso();
    await this.db.setSessionStatus(session.id, "waiting", now);
    await this.db.addAudit("local", "approval:repository_prefix", session.id, prompt.prefixRule.join(" "), now);
    this.liveApprovals.delete(session.id);
    this.publish("status.changed", session.id, { status: "waiting" });
  }

  async answerQuestion(sessionId: string, request: QuestionAnswerRequest): Promise<void> {
    const session = requireSession(await this.db.getSession(sessionId));
    const question = await this.getPendingQuestion(sessionId);
    if (!question) throw new QuestionResolutionError("No pending question for this session");
    const normalized = normalizeQuestionAnswer(question, request);
    await this.answerInteractiveQuestion(session, question, normalized);
    this.answeredQuestionMessageIds.add(question.messageId);
    const now = nowIso();
    await this.db.setSessionStatus(sessionId, "waiting", now);
    await this.db.addAudit("local", "question:answer", sessionId, "ok", now);
    this.publish("status.changed", sessionId, { status: "waiting" });
    this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
  }

  async listSessionDirectories(): Promise<SessionDirectorySuggestion[]> {
    const suggestions = new Map<string, SessionDirectorySuggestion>();
    const dismissedPaths = new Set(await this.db.listDismissedSessionDirectories());

    for (const session of await this.db.listSessions(false)) {
      if (session.status === "missing") continue;
      const candidate = session.gitWorkspace?.entryPath ?? session.repo.root ?? session.tmux.cwd;
      const next = await directorySuggestionFromPath(candidate, "active", session.lastActivityAt, {
        label: session.repo.name,
        repoRoot: session.repo.root,
        branch: session.repo.branch
      });
      if (next && !dismissedPaths.has(next.path)) suggestions.set(next.path, mergeDirectorySuggestion(suggestions.get(next.path), next));
    }

    for (const repository of await this.db.listTouchedRepositories()) {
      const next = await directorySuggestionFromPath(repository.path, "recent", repository.lastActivityAt, repository);
      if (next && !dismissedPaths.has(next.path)) suggestions.set(next.path, mergeDirectorySuggestion(suggestions.get(next.path), next));
    }

    return [...suggestions.values()].sort(compareDirectorySuggestions);
  }

  async dismissSessionDirectory(path: string): Promise<void> {
    await this.db.dismissSessionDirectory(path, nowIso());
  }

  async probeGitRepository(path: string) {
    const directory = await requireExistingDirectory(path);
    return this.gitWorkspaces?.probe(directory) ?? loadRepoMetadata(directory).then((repo) => ({
      isGit: Boolean(repo.root),
      bare: false,
      incompatibleReason: null,
      repoRoot: repo.root,
      repoName: repo.name,
      currentBranch: repo.branch,
      dirty: repo.dirty,
      remotes: [],
      defaultRemote: null,
      localBranches: [],
      remoteBranches: [],
      tags: []
    }));
  }

  async createSessionInDirectory(cwd: string, name: string): Promise<ManagedSession> {
    const directory = await requireExistingDirectory(cwd);
    const sessionName = requireSessionName(name);
    const launch = await this.tmux.createCodexWindowInMuxpilotSession(directory, sessionName, {
      environment: this.managedEnvironment
    });
    const session = await this.persistInitializingSession(launch.pane, directory);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "create_session", session.id, "ok", nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  async createSession(request: CreateSessionRequest): Promise<ManagedSession> {
    const directory = await requireExistingDirectory(request.cwd);
    const sessionName = requireSessionName(request.name);
    const probe = await this.gitWorkspaces?.probe(directory) ?? null;
    if (probe?.isGit && request.workspace?.mode !== "git") {
      throw new CreateSessionError("Target branch is required for new Git sessions", 400);
    }
    if (request.workspace?.mode !== "git") return this.createSessionInDirectory(directory, sessionName);
    if (!this.gitWorkspaces) throw new CreateSessionError("Managed Git workspaces are unavailable", 503);

    const workspace = await this.gitWorkspaces.provision({
      sessionName,
      entryPath: directory,
      targetBranch: request.workspace.targetBranch
    });
    const controlPath = await this.gitWorkspaces.ensureControlPath(workspace);
    const launch = await this.tmux.createCodexWindowInMuxpilotSession(
      controlPath,
      sessionName,
      managedCodexLaunchOptions(workspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment)
    );
    const sessionId = tmuxPaneSessionId(launch.pane);
    await this.gitWorkspaces.bind(workspace.id, sessionId);
    const session = await this.persistInitializingSession(launch.pane, workspace.summary.entryPath, workspace.summary);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "create_git_session", sessionId, workspace.id, nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  async forkSession(sessionId: string, name: string): Promise<ManagedSession> {
    const source = await this.db.getSession(sessionId);
    if (!source) throw new SessionNotFoundError("Session not found");
    if (!source.codexSessionId) throw new CreateSessionError("Session does not have a Codex session id to fork");
    const sessionNameValue = requireSessionName(name);
    const forkedFrom: SessionForkOrigin = {
      codexSessionId: source.codexSessionId,
      sessionId: source.id,
      sessionName: sessionName(source)
    };

    let launch;
    let gitWorkspace: GitWorkspaceSummary | null = null;
    let repoPath: string;
    if (source.gitWorkspace) {
      if (!this.gitWorkspaces) throw new CreateSessionError("Managed Git workspaces are unavailable", 503);
      const workspace = await this.gitWorkspaces.provision({
        sessionName: sessionNameValue,
        entryPath: source.gitWorkspace.entryPath,
        targetBranch: source.gitWorkspace.targetBranch
      });
      const controlPath = await this.gitWorkspaces.ensureControlPath(workspace);
      launch = await this.tmux.createCodexForkWindowInMuxpilotSession(
        controlPath,
        sessionNameValue,
        source.codexSessionId,
        managedCodexLaunchOptions(workspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment)
      );
      const forkSessionId = tmuxPaneSessionId(launch.pane);
      await this.gitWorkspaces.bind(workspace.id, forkSessionId);
      gitWorkspace = workspace.summary;
      repoPath = workspace.summary.entryPath;
    } else {
      repoPath = await requireExistingDirectory(source.repo.root ?? source.tmux.cwd);
      launch = await this.tmux.createCodexForkWindowInMuxpilotSession(repoPath, sessionNameValue, source.codexSessionId, {
        environment: this.managedEnvironment
      });
    }

    const session = await this.persistInitializingSession(launch.pane, repoPath, gitWorkspace, forkedFrom, source);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "fork_session", session.id, source.id, nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  private async persistInitializingSession(
    pane: TmuxPane,
    repoPath: string,
    gitWorkspace: GitWorkspaceSummary | null = null,
    forkedFrom: SessionForkOrigin | null = null,
    preferences?: Pick<ManagedSession, "inputMode" | "models" | "fastMode" | "fastModeAvailable">
  ): Promise<ManagedSession> {
    const now = nowIso();
    const session: ManagedSession = {
      id: tmuxPaneSessionId(pane),
      tmux: pane,
      repo: await loadRepoMetadata(repoPath),
      codexSessionId: null,
      codexJsonlPath: null,
      discoveryConfidence: "medium",
      status: "unknown",
      initializing: true,
      startupError: null,
      lastActivityAt: null,
      preview: "",
      recentUserPrompts: [],
      activitySummary: null,
      activitySummaryGeneratedAt: null,
      activitySummarySourceSequence: null,
      inputMode: preferences?.inputMode ?? "default",
      models: preferences?.models ?? emptySessionModels(),
      fastMode: preferences?.fastMode ?? null,
      fastModeAvailable: preferences?.fastModeAvailable ?? null,
      transcriptSize: 0,
      transcriptSyncing: false,
      unreadCount: 0,
      pinned: false,
      archived: false,
      forkedFrom,
      gitWorkspace
    };
    await this.db.upsertSession(session, now);
    const persisted = requireSession(await this.db.setSessionInitializing(session.id, true, now));
    await this.recordTouchedRepository(persisted, now);
    return persisted;
  }

  private finishSessionInitialization(sessionId: string, ready: Promise<void>): void {
    void ready
      .then(
        async () => {
          const discovered = await this.db.getSession(sessionId);
          this.readySessionDiscoveryGeneration.set(sessionId, this.discoveryGeneration);
          const session = await this.db.setSessionInitializationResult(
            sessionId,
            startupReadyStatus(discovered?.status),
            null,
            nowIso()
          );
          if (session) this.publish("session.updated", sessionId, session);
          this.runBackgroundTask("discovery", () => this.runDiscoverTick());
        },
        async (error) => {
          this.readySessionDiscoveryGeneration.delete(sessionId);
          console.error(`Muxpilot session ${sessionId} readiness check failed`, error);
          const startupError = error instanceof Error ? error.message : "Codex exited before startup completed.";
          const session = await this.db.setSessionInitializationResult(sessionId, "startup_failed", startupError, nowIso());
          if (session) {
            this.publish("status.changed", sessionId, { status: "startup_failed" });
            this.publish("session.updated", sessionId, session);
          }
        }
      )
      .catch((error) => {
        console.error(`Muxpilot session ${sessionId} initialization finalization failed`, error);
      });
  }

  async act(sessionId: string, action: SessionAction): Promise<ManagedSession | null> {
    const session = requireSession(await this.db.getSession(sessionId));
    if (action.type === "interrupt") {
      if (session.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(session.gitWorkspace.id, "session interrupted by operator");
      await this.tmux.interrupt(session.tmux.paneId);
      const now = nowIso();
      await this.db.setSessionStatus(sessionId, "waiting", now);
      this.publish("status.changed", sessionId, { status: "waiting" });
    }
    if (action.type === "choosePlanAction") {
      const latestPlanMessage = await this.db.latestPlanReadyMessage(sessionId);
      if (!latestPlanMessage) throw new InputModeSwitchError("No pending proposed plan for this session");
      const pane = await this.livePane(session);
      await this.tmux.sendKeys(pane.paneId, keysForPlanAction(action.action));
      this.answeredPlanMessageIds.add(latestPlanMessage.id);
      const now = nowIso();
      const mode = inputModeForPlanAction(action.action);
      const status = activeInputStatus(mode);
      await this.db.setSessionInputMode(sessionId, mode, now);
      await this.db.setSessionStatus(sessionId, status, now);
      this.pendingPlanActionStatuses.set(sessionId, { status, expiresAtMs: Date.now() + PLAN_ACTION_START_GRACE_MS });
      this.publish("status.changed", sessionId, { status });
    }
    if (action.type === "rename") {
      await this.tmux.renameWindow(session.tmux.paneId, requireSessionName(action.name));
      await this.refreshRenamedSession(session);
    }
    if (action.type === "pin") await this.db.setSessionPinned(sessionId, true, nowIso());
    if (action.type === "unpin") await this.db.setSessionPinned(sessionId, false, nowIso());
    if (action.type === "kill") {
      this.readySessionDiscoveryGeneration.delete(sessionId);
      if (session.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(session.gitWorkspace.id, "owning session was killed");
      await this.tmux.killPane(session.tmux.paneId);
    }
    if (action.type === "archiveTranscript") {
      this.readySessionDiscoveryGeneration.delete(sessionId);
      await this.db.markSessionArchived(sessionId, true, nowIso());
    }
    if (action.type === "setInputMode") {
      await this.ensureInputMode(session, action.mode);
      const updatedAt = nowIso();
      const updatedSession = await this.db.setSessionInputMode(sessionId, action.mode, updatedAt);
      await this.db.addAudit(
        "local",
        "set_input_mode",
        sessionId,
        JSON.stringify({
          previousMode: session.inputMode,
          requestedMode: action.mode,
          switchMethod: "cycle_keys",
          cycleKeys: this.inputModeCycleKeys,
          resultingMode: updatedSession?.inputMode ?? null
        }),
        updatedAt
      );
    }
    if (action.type === "setFastMode") {
      await this.setFastMode(session, action.enabled);
    }
    if (action.type === "retryInputDelivery") {
      await this.retryInputDelivery(session);
    }
    if (action.type === "dismissInputDeliveryFailure") {
      await this.dismissInputDeliveryFailure(session);
    }
    if (action.type === "detach") {
      this.publish("notification.created", sessionId, { title: "Detach requested", body: "Detach is managed by tmux clients." });
    }
    if (action.type === "kill") await this.discover();
    await this.db.addAudit("local", action.type, sessionId, "ok", nowIso());
    const updatedSession = await this.db.getSession(sessionId);
    this.publish("session.updated", sessionId, updatedSession);
    return updatedSession;
  }

  private async reconcileInputDeliveryState(
    message: ChatMessage | null,
    lifecycle: ChatMessage | null,
    inferredStatus: SessionStatus
  ): Promise<ChatMessage | null> {
    if (!message) return null;
    const submission = muxpilotSubmission(message);
    if (!submission || submission.state === "dismissed" || submission.state === "acknowledged") return message;

    const acknowledged = Boolean(
      lifecycle && lifecycle.sequence > message.sequence && lifecycle.text === "task_started"
    ) || isDeliveryAcknowledgingStatus(inferredStatus);
    if (acknowledged) return this.updateInputDelivery(message, { state: "acknowledged", failureReason: null });

    const attemptedAt = typeof submission.lastAttemptAt === "string" ? submission.lastAttemptAt : message.timestamp;
    const attemptedAtMs = Date.parse(attemptedAt);
    if (!Number.isFinite(attemptedAtMs) || Date.now() - attemptedAtMs < INPUT_DELIVERY_ACK_TIMEOUT_MS) return message;
    if (submission.state === "failed") return message;
    return this.updateInputDelivery(message, {
      state: "failed",
      failureReason: "Codex remained ready and did not acknowledge the submitted input."
    });
  }

  private async retryInputDelivery(session: ManagedSession): Promise<void> {
    const message = await this.db.latestUserMessage(session.id);
    const submission = message ? muxpilotSubmission(message) : null;
    if (!message || !submission || submission.state !== "failed") {
      throw new InputDeliveryError("There is no failed input delivery to retry");
    }
    const pane = await this.livePane(session);
    const inferred = await inferStatus(pane, session.status, (paneId, lines) => this.tmux.capturePane(paneId, lines, false));
    if (!isInputReadyStatus(inferred)) throw new InputDeliveryError("Codex is not ready to retry this input");

    const attemptedAt = nowIso();
    const attemptCount = typeof submission.attemptCount === "number" ? submission.attemptCount + 1 : 2;
    const pending = await this.updateInputDelivery(message, { state: "pending", attemptCount, lastAttemptAt: attemptedAt, failureReason: null });
    try {
      await this.sendRawInput(session, message.text);
    } catch (error) {
      await this.updateInputDelivery(message, { state: "failed", attemptCount, lastAttemptAt: attemptedAt, failureReason: "Muxpilot could not deliver the input to Codex." });
      throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
    }
    const status = activeInputStatus(collaborationModeFromMessage(message) ?? session.inputMode);
    await this.db.setSessionStatus(session.id, status, attemptedAt);
    this.publish("message.appended", session.id, pending);
    this.publish("status.changed", session.id, { status });
  }

  private async dismissInputDeliveryFailure(session: ManagedSession): Promise<void> {
    const message = await this.db.latestUserMessage(session.id);
    const submission = message ? muxpilotSubmission(message) : null;
    if (!message || !submission || submission.state !== "failed") {
      throw new InputDeliveryError("There is no failed input delivery to dismiss");
    }
    const updated = await this.updateInputDelivery(message, { state: "dismissed", failureReason: null });
    const now = nowIso();
    await this.db.setSessionStatus(session.id, "waiting", now);
    this.publish("message.appended", session.id, updated);
    this.publish("status.changed", session.id, { status: "waiting" });
  }

  private async updateInputDelivery(message: ChatMessage, changes: Record<string, unknown>): Promise<ChatMessage> {
    const current = muxpilotSubmission(message) ?? {};
    const updated = await this.db.updateMessagePayload(message, {
      ...message.payload,
      muxpilotSubmission: { ...current, ...changes }
    });
    if (!updated) throw new Error("Could not persist input delivery state");
    return updated;
  }

  private pendingPlanActionStatus(sessionId: string): SessionStatus | null {
    const pending = this.pendingPlanActionStatuses.get(sessionId);
    if (!pending) return null;
    if (pending.expiresAtMs > Date.now()) return pending.status;
    this.pendingPlanActionStatuses.delete(sessionId);
    return null;
  }

  private async answerInteractiveQuestion(
    session: ManagedSession,
    question: QuestionRequest,
    request: QuestionAnswerRequest
  ): Promise<void> {
    const pane = await this.livePane(session);
    const followupText: string[] = [];
    for (const prompt of question.questions) {
      const values = request.answers[prompt.id]?.answers.map((answer) => answer.trim()).filter(Boolean) ?? [];
      const value = values[0];
      if (!value) throw new QuestionResolutionError(`Answer is required for question: ${prompt.id}`);
      const optionIndex = prompt.options.findIndex((option) => option.label === value);
      if (optionIndex >= 0) {
        await this.tmux.sendKeys(pane.paneId, menuSelectionKeys(optionIndex));
        followupText.push(...values.slice(1));
        continue;
      }
      if (value === NONE_OF_THE_ABOVE_ANSWER && prompt.options.length > 0) {
        await this.tmux.sendKeys(pane.paneId, menuSelectionKeys(prompt.options.length));
        followupText.push(...values.slice(1));
        continue;
      }
      if (prompt.options.length > 0) await this.tmux.sendKeys(pane.paneId, menuSelectionKeys(prompt.options.length));
      await this.tmux.pasteText(pane.paneId, codexTerminalUserText(value));
      await this.tmux.sendKeys(pane.paneId, ["Enter"]);
      followupText.push(...values.slice(1));
    }
    if (followupText.length > 0) {
      await this.tmux.interrupt(pane.paneId);
      await this.tmux.sendInput(pane.paneId, codexTerminalUserText(followupText.join("\n\n")));
    }
  }

  private async processQueuedInputs(sessionId: string): Promise<void> {
    if (this.processingQueuedSessionIds.has(sessionId)) return;
    this.processingQueuedSessionIds.add(sessionId);
    try {
      if ((await this.db.deleteEchoedSentQueuedInputs(sessionId)) > 0) {
        this.publish("queue.updated", sessionId, { queuedInputs: await this.db.listQueuedInputs(sessionId) });
      }
      const inputs = await this.db.listQueuedInputs(sessionId);
      if (inputs.some((input) => input.status === "sending" || input.status === "sent")) return;
      const input = inputs.find((candidate) => candidate.status === "queued" || candidate.status === "failed");
      if (!input) return;

      const session = requireSession(await this.db.getSession(sessionId));
      if (session.gitWorkspace && await this.heavyCommandQueue?.hasDeferred(session.gitWorkspace.id)) return;
      if (!queuedInputMatchesSession(input, session)) {
        await this.markQueuedInputFailed(input, "Session source changed before this input was sent");
        return;
      }

      const readySession = await this.readyLiveSession(session);
      if (!readySession) return;

      const sending = { ...input, status: "sending" as const, error: null, updatedAt: nowIso() };
      await this.db.updateQueuedInput(sending);
      this.publish("queue.updated", sessionId, { queuedInputs: await this.db.listQueuedInputs(sessionId) });

      try {
        const liveSession = await this.ensureInputMode(readySession, sending.mode);
        await this.sendRawInput(liveSession, sending.text);
        const now = nowIso();
        await this.db.updateQueuedInput({ ...sending, status: "sent", updatedAt: now, sentAt: now });
        const message = await this.recordSubmittedInput(session, sending.text, sending.mode, now);
        await this.db.setSessionInputMode(sessionId, sending.mode, now);
        const status = activeInputStatus(sending.mode);
        await this.db.setSessionStatus(sessionId, status, now);
        await this.db.addAudit("local", `send_queued_input:${sending.mode}`, sessionId, "ok", now);
        this.publish("message.appended", sessionId, message);
        this.publish("status.changed", sessionId, { status });
        this.publish("queue.updated", sessionId, { queuedInputs: await this.db.listQueuedInputs(sessionId) });
        this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
      } catch (error) {
        await this.markQueuedInputFailed(sending, error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.processingQueuedSessionIds.delete(sessionId);
    }
  }

  private async readyLiveSession(session: ManagedSession): Promise<ManagedSession | null> {
    let liveSession: ManagedSession;
    try {
      liveSession = await this.liveSession(session);
    } catch {
      return null;
    }

    const status = await inferStatus(liveSession.tmux, liveSession.status, (paneId, lines) => this.tmux.capturePane(paneId, lines, false));
    if (!isInputReadyStatus(status)) return null;
    return { ...liveSession, status };
  }

  private async markQueuedInputFailed(input: QueuedInput, error: string): Promise<void> {
    const failed = { ...input, status: "failed" as const, error, updatedAt: nowIso(), sentAt: null };
    await this.db.updateQueuedInput(failed);
    await this.db.addAudit("local", "queued_input_failed", input.sessionId, error, failed.updatedAt);
    this.publish("queue.updated", input.sessionId, { queuedInputs: await this.db.listQueuedInputs(input.sessionId) });
  }

  private keysForDecision(decision: ApprovalDecision): string[] {
    if (decision === "approve_once") return this.approvalKeys.approveOnce;
    if (decision === "approve_for_prefix") return this.approvalKeys.approveForPrefix;
    if (decision === "deny") return this.approvalKeys.deny;
    throw new ApprovalResolutionError("This approval choice requires an interactive permission prompt");
  }

  private async captureInteractiveApprovalPrompt(session: ManagedSession): Promise<InteractiveApprovalPrompt | null> {
    try {
      const capture = await this.tmux.capturePane(session.tmux.paneId, 100, false);
      return parseInteractiveApprovalPrompt(capture);
    } catch {
      return null;
    }
  }

  private async capturePaneApprovalPrompt(pane: TmuxPane): Promise<InteractiveApprovalPrompt | null> {
    try {
      return parseInteractiveApprovalPrompt(await this.tmux.capturePane(pane.paneId, 100, false));
    } catch {
      return null;
    }
  }

  private async corroboratedLiveApproval(
    pane: TmuxPane,
    latestMessage: ChatMessage | null
  ): Promise<InteractiveApprovalPrompt | null> {
    try {
      const prompt = parseInteractiveApprovalPrompt(await this.tmux.capturePane(pane.paneId, 100, false));
      return prompt && interactiveApprovalHasTranscriptContext(prompt, latestMessage) ? prompt : null;
    } catch {
      return null;
    }
  }

  private async isApprovalGateVisible(session: ManagedSession): Promise<boolean> {
    try {
      const capture = await this.tmux.capturePane(session.tmux.paneId, 100, false);
      return looksLikeApprovalScreen(capture);
    } catch {
      return looksLikeApprovalScreen(`${session.tmux.title}\n${session.tmux.windowName}`);
    }
  }

  private async ensureInputMode(session: ManagedSession, mode: CollaborationMode): Promise<ManagedSession> {
    let liveSession = await this.liveSession(session);
    const currentMode = detectCollaborationModeFromPane(liveSession.tmux);
    if (currentMode === mode || (currentMode === null && session.inputMode === mode)) return liveSession;

    await this.tmux.sendKeys(liveSession.tmux.paneId, this.inputModeCycleKeys);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await delay(120);
      liveSession = await this.liveSession(liveSession);
      if (detectCollaborationModeFromPane(liveSession.tmux) === mode) return liveSession;
      try {
        const capture = await this.tmux.capturePane(liveSession.tmux.paneId, 30, false);
        if (detectCollaborationModeFromText(capture) === mode) return liveSession;
      } catch {
        // The pane title remains the primary signal when capture is unavailable.
      }
    }

    return liveSession;
  }

  private async setFastMode(session: ManagedSession, enabled: boolean): Promise<void> {
    if (!canToggleFastMode(session.status)) {
      throw new FastModeSwitchError("Fast mode cannot be changed in the session's current state");
    }
    if (session.fastModeAvailable === false) {
      throw new FastModeSwitchError("Fast mode is not available for the active Codex model");
    }
    if (!session.codexJsonlPath) {
      throw new FastModeSwitchError("Fast mode is unavailable until the Codex session is detected");
    }

    const observed = await readLatestCodexFastMode(session.codexJsonlPath);
    if (observed === enabled || (observed === null && session.fastMode === enabled)) {
      await this.db.setSessionFastMode(session.id, enabled, nowIso());
      return;
    }

    const pane = await this.livePane(session);
    await this.tmux.sendInput(pane.paneId, "/fast");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100);
      if (await readLatestCodexFastMode(session.codexJsonlPath) !== enabled) continue;
      const updatedAt = nowIso();
      await this.db.setSessionFastMode(session.id, enabled, updatedAt);
      await this.db.addAudit(
        "local",
        "set_fast_mode",
        session.id,
        JSON.stringify({ enabled, command: "/fast" }),
        updatedAt
      );
      return;
    }
    throw new FastModeSwitchError("Codex did not confirm the Fast mode change");
  }

  private async liveSession(session: ManagedSession): Promise<ManagedSession> {
    const pane = await this.livePane(session);
    return { ...session, tmux: pane };
  }

  private async livePane(session: ManagedSession): Promise<TmuxPane> {
    const panes = await this.tmux.listPanes();
    const pane = panes.find((candidate) => tmuxPaneSessionId(candidate) === session.id);
    if (pane) return pane;
    if (panes.some((candidate) => candidate.paneId === session.tmux.paneId)) {
      throw new Error("Session pane no longer matches this chat session");
    }
    throw new Error("Session pane is no longer available in tmux");
  }

  private async findLiveSessionByRecoveryIdentity(identity: string): Promise<ManagedSession | null> {
    const sessions = await this.db.listSessions(true);
    for (const session of sessions) {
      if (recoveryIdentityForSession(session) !== identity) continue;
      if (session.status === "missing") continue;
      try {
        return await this.liveSession(session);
      } catch {
        // Discovery will mark stale rows missing on the next tick.
      }
    }
    return null;
  }

  private async findLiveSessionByCodexSessionId(codexSessionId: string): Promise<ManagedSession | null> {
    const sessions = await this.db.listSessions(true);
    for (const session of sessions) {
      if (session.codexSessionId !== codexSessionId || session.status === "missing") continue;
      try {
        return await this.liveSession(session);
      } catch {
        // Discovery will mark stale rows missing on the next tick.
      }
    }
    return null;
  }

  private async rebindRestoredSession(source: ManagedSession, pane: TmuxPane): Promise<ManagedSession> {
    const now = nowIso();
    const repo = await loadRepoMetadata(source.gitWorkspace?.entryPath ?? pane.cwd);
    const parserOffsetMove =
      source.codexJsonlPath ? { from: parserOffsetKey(source.id, source.codexJsonlPath), to: parserOffsetKey(tmuxPaneSessionId(pane), source.codexJsonlPath) } : null;
    const session: ManagedSession = {
      id: tmuxPaneSessionId(pane),
      tmux: pane,
      repo,
      codexSessionId: source.codexSessionId,
      codexJsonlPath: source.codexJsonlPath,
      discoveryConfidence: "medium",
      status: "unknown",
      initializing: true,
      startupError: null,
      lastActivityAt: source.lastActivityAt,
      preview: source.preview,
      recentUserPrompts: source.recentUserPrompts,
      activitySummary: source.activitySummary,
      activitySummaryGeneratedAt: source.activitySummaryGeneratedAt,
      activitySummarySourceSequence: source.activitySummarySourceSequence,
      inputMode: source.inputMode,
      models: source.models,
      fastMode: source.fastMode ?? null,
      fastModeAvailable: source.fastModeAvailable ?? null,
      transcriptSize: source.transcriptSize,
      transcriptSyncing: source.transcriptSyncing === true,
      unreadCount: source.unreadCount,
      pinned: source.pinned,
      archived: false,
      forkedFrom: source.forkedFrom ?? null,
      gitWorkspace: source.gitWorkspace ?? null
    };
    const rebound = await this.db.rekeySession(source.id, session, parserOffsetMove, now);
    if (!rebound) throw new SessionRestoreError("Session not found");
    await this.recordTouchedRepository(session, now);
    return requireSession(rebound);
  }

  private async refreshRenamedSession(session: ManagedSession): Promise<void> {
    const liveSession = await this.liveSession(session);
    const now = nowIso();
    await this.db.upsertSession(liveSession, now);
    await this.recordTouchedRepository(liveSession, now);
  }

  private async recordTouchedRepository(session: ManagedSession, updatedAt: string): Promise<void> {
    const candidate = session.gitWorkspace?.entryPath ?? session.repo.root ?? session.tmux.cwd;
    const path = await existingDirectoryPath(candidate);
    if (!path) return;
    await this.db.upsertTouchedRepository(
      {
        path,
        label: session.repo.name || basename(path),
        repoRoot: session.repo.root,
        branch: session.repo.branch,
        lastActivityAt: session.lastActivityAt
      },
      updatedAt
    );
  }

  private publish(
    type: "session.updated" | "message.appended" | "status.changed" | "notification.created" | "queue.updated",
    sessionId: string,
    payload: unknown
  ): void {
    const event = {
      id: eventId(),
      type,
      sessionId,
      payload,
      timestamp: nowIso()
    };
    this.events.publish(event);
  }

  private async shouldIncludePane(
    pane: TmuxPane,
    processInfo: CodexProcessInfo | null,
    existing: ManagedSession | null
  ): Promise<boolean> {
    if (processInfo) return true;
    if (existing && sameLivePaneProcess(existing, pane)) return true;
    if (looksLikeCodexPane(pane)) return true;
    if (pane.currentCommand !== "node") return false;

    try {
      const capture = await this.tmux.capturePane(pane.paneId, 80, false);
      return looksLikeCodexScreen(capture);
    } catch {
      return false;
    }
  }

  private async latestQuestionAnswerMessage(sessionId: string, questionMessage: ChatMessage | null): Promise<ChatMessage | null> {
    if (!questionMessage) return null;
    const question = materializeQuestion(questionMessage);
    if (!question) return null;
    return this.db.latestQuestionAnswerMessage(sessionId, question.id, questionMessage.sequence);
  }

  private async withTranscriptSource<T extends TranscriptPageResponse | TranscriptSearchResponse>(sessionId: string, page: T): Promise<T> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new SessionNotFoundError("Session not found");
    return {
      ...page,
      sessionId: session.id,
      codexSessionId: session.codexSessionId,
      codexJsonlPath: session.codexJsonlPath
    };
  }
}

export function normalizeRepositoryApprovalPrefix(prefixRule: string[], workspace: StoredGitWorkspace): string[] {
  const exactWorktree = workspace.summary.worktreePath;
  const implementationRoot = workspace.implementationRoot;
  return prefixRule.map((part) => {
    let normalized = exactWorktree ? part.replaceAll(exactWorktree, "$MUXPILOT_WORKTREE") : part;
    if (implementationRoot) {
      const taskPath = new RegExp(`${escapeRegExp(implementationRoot)}[/\\\\][^/\\\\\\s'\"]+`, "g");
      normalized = normalized.replace(taskPath, "$MUXPILOT_WORKTREE");
    }
    return normalized;
  });
}

export class ApprovalResolutionError extends Error {
  readonly statusCode = 409;
}

export class QuestionResolutionError extends Error {
  readonly statusCode = 409;
}

export class InputModeSwitchError extends Error {
  readonly statusCode = 409;
}

export class FastModeSwitchError extends Error {
  readonly statusCode = 409;
}

export class InputDeliveryError extends Error {
  readonly statusCode = 409;
}

export class SessionNameError extends Error {
  readonly statusCode = 400;
}

export class CreateSessionError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class SessionRestoreError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class QueuedInputError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class SessionNotFoundError extends Error {
  readonly statusCode = 404;
}

function resolveSessionStatus(
  inferredStatus: SessionStatus,
  inputMode: CollaborationMode,
  latestQuestionMessage: ChatMessage | null,
  latestQuestionAnswerMessage: ChatMessage | null,
  latestPlanReadyMessage: ChatMessage | null,
  latestUserMessage: ChatMessage | null,
  latestTurnLifecycleMessage: ChatMessage | null,
  pendingPlanActionStatus: SessionStatus | null,
  answeredPlanMessageIds: Set<string>,
  answeredQuestionMessageIds: Set<string>
): SessionStatus {
  if (inferredStatus === "startup_failed") return inferredStatus;
  const pendingStatus = preservePendingStatus(
    inferredStatus,
    latestQuestionMessage,
    latestQuestionAnswerMessage,
    latestPlanReadyMessage,
    latestUserMessage,
    answeredPlanMessageIds,
    answeredQuestionMessageIds
  );
  if (pendingStatus === "waiting" && inputDeliveryState(latestUserMessage) === "failed") return "input_failed";
  if (
    pendingStatus === "waiting" &&
    (pendingPlanActionStatus || isPendingMuxpilotSubmission(latestUserMessage, latestTurnLifecycleMessage))
  ) {
    return pendingPlanActionStatus ?? activeInputStatus(inputMode);
  }
  if (isWorkingStatus(pendingStatus) && isPlanModeTurn(latestUserMessage, inputMode)) return "planning";
  return pendingStatus;
}

function activeInputStatus(mode: CollaborationMode): SessionStatus {
  return mode === "plan" ? "planning" : "working";
}

function isPendingMuxpilotSubmission(
  latestUserMessage: ChatMessage | null,
  latestTurnLifecycleMessage: ChatMessage | null
): boolean {
  if (!latestUserMessage || !recordValue(latestUserMessage.payload.muxpilotSubmission)) return false;
  const state = inputDeliveryState(latestUserMessage);
  if (state === "failed" || state === "dismissed") return false;
  if (!latestTurnLifecycleMessage || latestTurnLifecycleMessage.sequence < latestUserMessage.sequence) return true;
  return latestTurnLifecycleMessage.text === "task_started";
}

function muxpilotSubmission(message: ChatMessage): Record<string, unknown> | null {
  return recordValue(message.payload.muxpilotSubmission);
}

function inputDeliveryState(message: ChatMessage | null): string | null {
  if (!message) return null;
  const submission = muxpilotSubmission(message);
  return typeof submission?.state === "string" ? submission.state : submission ? "pending" : null;
}

function isTurnCompletionMessage(message: ChatMessage): boolean {
  return message.type === "status" && (
    message.text === "task_complete" ||
    message.text === "turn_complete" ||
    message.text === "turn_aborted"
  );
}

function requireSessionName(input: string): string {
  const name = normalizeSessionName(input);
  if (!isValidSessionName(name)) throw new SessionNameError("Session name must be a 2-32 character Git-style name");
  return name;
}

function restoreSessionName(session: ManagedSession): string {
  for (const candidate of [session.tmux.windowName, session.repo.name, "restored"]) {
    const name = normalizeSessionName(candidate);
    if (isValidSessionName(name)) return name;
  }
  return "restored";
}

export function managedCodexLaunchOptions(
  workspace: StoredGitWorkspace,
  codexHome: string | null = process.env.CODEX_HOME ?? null,
  worktreeRoot: string | null = null,
  managedEnvironment: Record<string, string> = {}
) {
  const summary = workspace.summary;
  const helperDir = codexHome ? join(codexHome, "skills", "muxpilot-git-workflow", "scripts") : null;
  const implementationRoot = workspace.implementationRoot ?? worktreeRoot ?? join(summary.repoRoot, ".muxpilot-worktrees", workspace.id);
  const dependencies = reusableDependencyLinks(summary.dependencyLinks ?? []);
  return {
    isolatedWorkspace: true,
    writableRoots: [
      implementationRoot,
      workspace.commonGitDir,
      worktreeRoot,
      ...dependencies.map((dependency) => dependency.sourcePath)
    ].filter((value): value is string => Boolean(value)),
    developerInstructions: [
      "This is a local-only muxpilot Git session running from a neutral control directory.",
      "Use $muxpilot-git-workflow for every change task.",
      `Repository entry path: ${summary.entryPath}.`,
      `Initial target branch: ${summary.targetBranch}.`,
      "For change or build tasks, first resolve the intended target and complete any required fixed-target confirmation and retarget, then announce the workflow action, run the begin helper, and perform every repository content write in its short-lived worktree.",
      helperDir
        ? `Workflow helpers: begin with node ${JSON.stringify(join(helperDir, "muxpilot-git-begin.mjs"))}; inspect status with node ${JSON.stringify(join(helperDir, "muxpilot-git-status.mjs"))}; change target with node ${JSON.stringify(join(helperDir, "muxpilot-git-target.mjs"))}; finalize with node ${JSON.stringify(join(helperDir, "muxpilot-git-finish.mjs"))}.`
        : "Use the helper directory provided by the workflow environment.",
      "Workflow status is authoritative for the current target after a retarget.",
      "For answers, plans, reviews, and diagnosis, inspect the repository directly without creating a worktree.",
      "Before repository work, inspect applicable repository instructions from the entry path because the control directory is not the project root.",
      "Before integration, repeatedly self-review the complete diff, fix every finding, and run focused file/module checks until the review is clean. Do not treat this same-agent self-review as a PR-style review. Run repository-wide scans or test suites only when the user explicitly requests them, or when the user explicitly requests a PR-style review of a branch or ref.",
      "Treat a command as heavyweight if it covers an entire repository, workspace, application, package, or multi-project configuration; performs static-analysis, security, dependency, or container-image scanning such as Semgrep, CodeQL, or Trivy; starts Docker or Docker Compose; launches multiple workers, shards, or projects; produces a production bundle; or is reasonably expected to run longer than one minute, use more than about 1 GiB of memory, or sustain multiple CPU cores. Selected-file lint, syntax-only checks, and one explicitly selected test file or test case without parallel workers are normally not heavyweight. When uncertain, treat the command as heavyweight. Run every heavyweight command through muxpilot-git-run.mjs --heavy -- <command>. The wrapper schedules an already-authorized command; it does not authorize repository-wide validation, and its availability is not a reason to broaden a focused check.",
      "If the heavyweight wrapper reports QUEUED_NOT_RUN, use $muxpilot-heavy-command-queue. The command did not run; do not poll or retry it.",
      "User instructions take priority over muxpilot guardrails. If an instruction conflicts with a muxpilot guard, name each exact guard and consequence and obtain explicit confirmation for those guards before bypassing them. Confirmation is operation-scoped; platform safety rules are not muxpilot guards.",
      "When a change request creates or selects a local branch for implementation, treat that destination branch as the intended session target even if the user does not explicitly say to change the target; a source ref such as origin/dev is only the start point. If it differs from workflow status, before creating the branch or beginning implementation name the fixed-target guard, explain that current and future task commits will integrate there, and obtain separate explicit confirmation for the fixed-target bypass. An active worktree must repeat focused checks and self-review after retargeting before integration.",
      "Never use an implementation worktree's state to claim that another checkout is clean or dirty; inspect the actual checkout before reporting its working-copy state.",
      "If a requested write is outside the sandbox's writable roots, use normal approval or escalation instead of refusing it as out of scope.",
      "Shared dependency links are writable for test caches. Before installing or changing dependencies, localize the relevant link with the dependency helper.",
      "Create clean atomic commits and run the finish helper before reporting completion."
    ].join(" "),
    environment: {
      ...managedEnvironment,
      ...(codexHome ? { CODEX_HOME: codexHome, MUXPILOT_GIT_HELPER_DIR: helperDir! } : {}),
      MUXPILOT_GIT_WORKSPACE_ID: workspace.id,
      MUXPILOT_GIT_REPO_ROOT: summary.repoRoot,
      MUXPILOT_GIT_ENTRY_PATH: summary.entryPath,
      MUXPILOT_GIT_TARGET_BRANCH: summary.targetBranch,
      MUXPILOT_GIT_WORKTREE_ROOT: implementationRoot,
      MUXPILOT_GIT_STATUS_FILE: statusPath(workspace),
      MUXPILOT_GIT_DEPENDENCIES: JSON.stringify(dependencies)
    }
  };
}

function collapseHistoryByIdentity(results: SessionHistoryResult[], limit: number): SessionHistoryResult[] {
  const byIdentity = new Map<string, SessionHistoryResult>();
  for (const result of results) {
    const identity = sessionHistoryIdentity(result);
    const current = byIdentity.get(identity);
    if (!current || historyResultPreference(result, current) < 0) {
      byIdentity.set(identity, result);
    }
  }
  return [...byIdentity.values()].slice(0, limit);
}

function recoverableLiveSessionIds(sessions: ManagedSession[]): string[] {
  return sessions
    .filter((session) => !session.archived && session.status !== "missing" && Boolean(session.codexSessionId))
    .map((session) => session.id);
}

function recoveryCandidateFromSession(session: ManagedSession): SessionRecoveryCandidate {
  const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
  return {
    sessionId: session.id,
    codexSessionId: session.codexSessionId ?? "",
    codexJsonlPath: session.codexJsonlPath,
    status: "missing",
    previousStatus: session.status,
    archived: false,
    sessionName: sessionName(session),
    repoName: session.repo.name,
    repoBranch: session.repo.branch,
    cwd: session.tmux.cwd,
    lastActivityAt: session.lastActivityAt,
    transcriptSize: session.transcriptSize,
    matchedPrompts: session.recentUserPrompts.map((text, index) => ({
      sequence: Math.max(0, session.transcriptSize - index),
      timestamp: session.lastActivityAt ?? "",
      text
    })),
    gitWorkspace: workspace ? {
      id: workspace.id,
      worktreePath: workspace.worktreePath,
      sessionBranch: workspace.sessionBranch,
      targetBranch: workspace.targetBranch
    } : null
  };
}

function recoveryIdentityForSession(session: ManagedSession): string {
  const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
  return workspace ? `workspace:${workspace.id}` : `codex:${session.codexSessionId ?? session.id}`;
}

function mergeRecoveryCandidates(
  current: SessionRecoveryCandidate[],
  discovered: SessionRecoveryCandidate[]
): SessionRecoveryCandidate[] {
  const byIdentity = new Map<string, SessionRecoveryCandidate>();
  for (const candidate of [...current, ...discovered]) {
    byIdentity.set(sessionHistoryIdentity(candidate), candidate);
  }
  return [...byIdentity.values()].sort((first, second) => {
    const firstTime = first.lastActivityAt ? Date.parse(first.lastActivityAt) : Number.NEGATIVE_INFINITY;
    const secondTime = second.lastActivityAt ? Date.parse(second.lastActivityAt) : Number.NEGATIVE_INFINITY;
    return secondTime - firstTime || first.sessionName.localeCompare(second.sessionName);
  });
}

function preferredForkSource(sessions: ManagedSession[]): ManagedSession | null {
  return [...sessions].sort((first, second) => {
    const firstLive = first.status !== "missing" && !first.archived;
    const secondLive = second.status !== "missing" && !second.archived;
    if (firstLive !== secondLive) return firstLive ? -1 : 1;
    const firstTime = first.lastActivityAt ? Date.parse(first.lastActivityAt) : Number.NEGATIVE_INFINITY;
    const secondTime = second.lastActivityAt ? Date.parse(second.lastActivityAt) : Number.NEGATIVE_INFINITY;
    return secondTime - firstTime;
  })[0] ?? null;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === "function");
}

function sessionName(session: ManagedSession): string {
  return session.tmux.windowName.trim() || session.tmux.sessionName.trim() || session.repo.name || "session";
}

function historyResultPreference(first: SessionHistoryResult, second: SessionHistoryResult): number {
  const firstLive = first.status !== "missing" && !first.archived;
  const secondLive = second.status !== "missing" && !second.archived;
  if (firstLive !== secondLive) return firstLive ? -1 : 1;
  const firstTime = first.lastActivityAt ? Date.parse(first.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const secondTime = second.lastActivityAt ? Date.parse(second.lastActivityAt) : Number.NEGATIVE_INFINITY;
  return secondTime - firstTime;
}

function preservePendingStatus(
  inferredStatus: SessionStatus,
  latestQuestionMessage: ChatMessage | null,
  latestQuestionAnswerMessage: ChatMessage | null,
  latestPlanReadyMessage: ChatMessage | null,
  latestUserMessage: ChatMessage | null,
  answeredPlanMessageIds: Set<string>,
  answeredQuestionMessageIds: Set<string>
): SessionStatus {
  if (
    activeQuestionMessage(
      latestQuestionMessage,
      latestQuestionAnswerMessage,
      latestUserMessage,
      latestPlanReadyMessage,
      answeredPlanMessageIds,
      answeredQuestionMessageIds
    )
  ) {
    return "question";
  }
  if (latestPlanReadyMessage && !answeredPlanMessageIds.has(latestPlanReadyMessage.id)) return "plan_ready";
  return inferredStatus;
}

function activeQuestionMessage(
  latestQuestionMessage: ChatMessage | null,
  latestQuestionAnswerMessage: ChatMessage | null,
  latestUserMessage: ChatMessage | null,
  latestPlanReadyMessage: ChatMessage | null,
  answeredPlanMessageIds: Set<string>,
  answeredQuestionMessageIds: Set<string>
): ChatMessage | null {
  if (!latestQuestionMessage) return null;
  if (answeredQuestionMessageIds.has(latestQuestionMessage.id)) return null;
  if (latestQuestionAnswerMessage && latestQuestionAnswerMessage.sequence > latestQuestionMessage.sequence) return null;
  if (latestUserMessage && latestUserMessage.sequence > latestQuestionMessage.sequence) return null;
  if (
    latestPlanReadyMessage &&
    latestPlanReadyMessage.sequence > latestQuestionMessage.sequence &&
    !answeredPlanMessageIds.has(latestPlanReadyMessage.id)
  ) {
    return null;
  }
  return latestQuestionMessage;
}

function isWorkingStatus(status: SessionStatus): boolean {
  return status === "working" || status === "generating" || status === "executing";
}

function isInputReadyStatus(status: SessionStatus): boolean {
  return status === "waiting" || status === "idle";
}

function isDeliveryAcknowledgingStatus(status: SessionStatus): boolean {
  return status === "working" || status === "generating" || status === "executing" ||
    status === "approval" || status === "question" || status === "plan_ready";
}

function queuedInputMatchesSession(input: QueuedInput, session: ManagedSession): boolean {
  return input.codexSessionId === session.codexSessionId && input.codexJsonlPath === session.codexJsonlPath;
}

function isPlanModeUserMessage(message: ChatMessage | null): boolean {
  return message?.role === "user" && recordValue(message.payload)?.collaborationMode === "plan";
}

function isPlanModeTurn(latestUserMessage: ChatMessage | null, inputMode: CollaborationMode): boolean {
  if (isPlanModeUserMessage(latestUserMessage)) return true;
  return inputMode === "plan" && latestUserMessage?.role === "user";
}

function collaborationModeFromMessage(message: ChatMessage): CollaborationMode | null {
  const mode = recordValue(message.payload)?.collaborationMode;
  return mode === "default" || mode === "plan" ? mode : null;
}

function isPlanReadyMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && message.type === "assistant" && hasCompleteProposedPlan(message.text);
}

function isPlanActionInput(text: string): boolean {
  return (
    text === "Yes, implement the plan" ||
    text === "Yes, clear context and implement" ||
    text === "No, stay in plan mode"
  );
}

function codexTerminalUserText(text: string): string {
  return text.endsWith(" ") ? text : `${text} `;
}

function keysForPlanAction(action: PlanActionChoice): string[] {
  if (action === "implement") return ["Enter"];
  if (action === "clear_context_implement") return ["Down", "Enter"];
  return ["Down", "Down", "Enter"];
}

function inputModeForPlanAction(action: PlanActionChoice): CollaborationMode {
  return action === "stay_in_plan" ? "plan" : "default";
}

function menuSelectionKeys(index: number): string[] {
  return [...Array.from({ length: index }, () => "Down"), "Enter"];
}

const NONE_OF_THE_ABOVE_ANSWER = "None of the above";

async function claimCodexFile(
  pane: TmuxPane,
  existing: ManagedSession | null,
  files: CodexSessionFile[],
  claims: Set<string>,
  processInfo: CodexProcessInfo | null,
  capturePane: (lines: number) => Promise<string>,
  growingPaths: ReadonlySet<string>,
  reconsideredPaths: ReadonlySet<string>,
  allowUncorroboratedSuccessor: boolean
): Promise<CodexSessionFile | null> {
  const exact = files.filter((file) => file.cwd === pane.cwd);
  const existingMatch = exact.find((file) => file.path === existing?.codexJsonlPath);
  const compatibleExact = exact.filter((file) => !claims.has(file.path) || file.path === existingMatch?.path);

  const resumedMatch = matchByResumedSessionId(processInfo, compatibleExact);
  // A fresh context can start a new rollout without changing the long-lived
  // process argv. Use that resume id immediately only for an unbound pane;
  // established bindings must pass live continuity checks before falling back.
  if (resumedMatch && !existingMatch && !claims.has(resumedMatch.path)) {
    claims.add(resumedMatch.path);
    return resumedMatch;
  }

  const alternativeChanged = compatibleExact.some(
    (file) => file.path !== existingMatch?.path && reconsideredPaths.has(file.path)
  );
  if (existingMatch && !claims.has(existingMatch.path) && (growingPaths.has(existingMatch.path) || !alternativeChanged)) {
    claims.add(existingMatch.path);
    return existingMatch;
  }

  const visibleMatch = await visibleCodexFileForPane(compatibleExact, capturePane, existingMatch?.path);
  if (visibleMatch && !claims.has(visibleMatch.path)) {
    claims.add(visibleMatch.path);
    return visibleMatch;
  }

  const growingSuccessor = uniqueGrowingSuccessor(compatibleExact, existingMatch, growingPaths);
  if (
    growingSuccessor &&
    (!resumedMatch || allowUncorroboratedSuccessor) &&
    !claims.has(growingSuccessor.path)
  ) {
    claims.add(growingSuccessor.path);
    return growingSuccessor;
  }

  if (resumedMatch && !claims.has(resumedMatch.path)) {
    claims.add(resumedMatch.path);
    return resumedMatch;
  }

  const startTimeMatch = matchByProcessStart(processInfo, compatibleExact);
  if (startTimeMatch && !claims.has(startTimeMatch.path)) {
    claims.add(startTimeMatch.path);
    return startTimeMatch;
  }

  if (existingMatch && !claims.has(existingMatch.path)) {
    claims.add(existingMatch.path);
    return existingMatch;
  }

  const unclaimedExact = exact.filter((file) => !claims.has(file.path));
  if (unclaimedExact.length === 1) {
    const match = unclaimedExact[0];
    if (match) claims.add(match.path);
    return match ?? null;
  }

  const repoName = basename(pane.cwd);
  const fuzzy = files.filter((file) => file.cwd && basename(file.cwd) === repoName && !claims.has(file.path));
  if (fuzzy.length === 0) return null;
  const match = await bestCodexFileForPane(fuzzy, processInfo, capturePane);
  if (match) claims.add(match.path);
  return match;
}

function growingCodexFiles(
  files: CodexSessionFile[],
  previous: ReadonlyMap<string, { sizeBytes: number; updatedAtMs: number }>
): Set<string> {
  return new Set(
    files
      .filter((file) => {
        const observed = previous.get(file.path);
        return Boolean(observed && (file.sizeBytes > observed.sizeBytes || file.updatedAtMs > observed.updatedAtMs));
      })
      .map((file) => file.path)
  );
}

function reconsideredCodexFiles(
  files: CodexSessionFile[],
  previous: ReadonlyMap<string, { sizeBytes: number; updatedAtMs: number }>
): Set<string> {
  // Reconsider persisted bindings once after startup, before file growth has
  // established which rollout is live.
  if (previous.size === 0) return new Set(files.map((file) => file.path));
  return new Set(
    files
      .filter((file) => {
        const observed = previous.get(file.path);
        return !observed || file.sizeBytes !== observed.sizeBytes || file.updatedAtMs !== observed.updatedAtMs;
      })
      .map((file) => file.path)
  );
}

function uniqueGrowingSuccessor(
  candidates: CodexSessionFile[],
  existing: CodexSessionFile | undefined,
  growingPaths: ReadonlySet<string>
): CodexSessionFile | null {
  if (!existing || growingPaths.has(existing.path)) return null;
  const successors = candidates.filter(
    (file) =>
      file.path !== existing.path &&
      file.startedAtMs !== null &&
      (existing.startedAtMs === null || file.startedAtMs > existing.startedAtMs) &&
      growingPaths.has(file.path)
  );
  return successors.length === 1 ? successors[0] ?? null : null;
}

async function bestCodexFileForPane(
  candidates: CodexSessionFile[],
  processInfo: CodexProcessInfo | null,
  capturePane: (lines: number) => Promise<string>
): Promise<CodexSessionFile | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const resumedMatch = matchByResumedSessionId(processInfo, candidates);
  if (resumedMatch) return resumedMatch;

  const visibleMatch = await visibleCodexFileForPane(candidates, capturePane);
  if (visibleMatch) return visibleMatch;

  return matchByProcessStart(processInfo, candidates);
}

async function visibleCodexFileForPane(
  candidates: CodexSessionFile[],
  capturePane: (lines: number) => Promise<string>,
  stablePath?: string | null
): Promise<CodexSessionFile | null> {
  if (candidates.length <= 1) return null;

  try {
    const capture = await capturePane(120);
    const scored = await Promise.all(
      candidates.map(async (file) => ({
        file,
        score: await transcriptOverlapScore(file, capture)
      }))
    );
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.file.path === stablePath) - Number(a.file.path === stablePath) ||
        b.file.updatedAtMs - a.file.updatedAtMs
    );
    const best = scored[0];
    const stable = stablePath ? scored.find((candidate) => candidate.file.path === stablePath) : null;
    if (stable && stable.score > 0 && best && best.file.path !== stable.file.path && best.score <= stable.score) {
      return stable.file;
    }
    if (best && best.score > 0) return best.file;
  } catch {
    // Leave ambiguous candidates unbound when visible transcript matching is unavailable.
  }

  return null;
}

function matchByResumedSessionId(processInfo: CodexProcessInfo | null, candidates: CodexSessionFile[]): CodexSessionFile | null {
  if (!processInfo?.sessionId) return null;
  return candidates.find((file) => file.sessionId === processInfo.sessionId) ?? null;
}

function matchByProcessStart(processInfo: CodexProcessInfo | null, candidates: CodexSessionFile[]): CodexSessionFile | null {
  if (!processInfo?.startedAtMs) return null;
  const withStart = candidates.filter((file) => file.startedAtMs !== null);
  if (withStart.length === 0) return null;
  const scored = withStart
    .map((file) => ({
      file,
      delta: Math.abs((file.startedAtMs ?? 0) - processInfo.startedAtMs!)
    }))
    .sort((a, b) => a.delta - b.delta || b.file.updatedAtMs - a.file.updatedAtMs);
  const best = scored[0];
  const next = scored[1];
  if (!best || best.delta > 10 * 60 * 1000) return null;
  if (next && next.delta === best.delta) return null;
  return best.file;
}

interface CodexTailAnalysis {
  sizeBytes: number;
  updatedAtMs: number;
  overlapChunks: string[];
  modelSettings: SessionModelSettings | null;
}

const CODEX_TAIL_ANALYSIS_CACHE_LIMIT = 512;
const codexTailAnalysisCache = new Map<string, CodexTailAnalysis>();

export async function transcriptOverlapScore(file: CodexSessionFile, capture: string): Promise<number> {
  const visible = normalizeOverlapText(capture);
  if (!visible) return 0;
  const chunks = (await readCodexTailAnalysis(file)).overlapChunks;

  let score = 0;
  for (const text of chunks) {
    if (visible.includes(text)) score += Math.min(text.length, 400);
  }
  return score;
}

export function clearCodexTailAnalysisCache(): void {
  codexTailAnalysisCache.clear();
}

async function readCodexTailAnalysis(file: CodexSessionFile): Promise<CodexTailAnalysis> {
  const cached = codexTailAnalysisCache.get(file.path);
  if (cached && cached.sizeBytes === file.sizeBytes && cached.updatedAtMs === file.updatedAtMs) return cached;

  const tail = await readFileTail(file.path, 256 * 1024);
  const analysis: CodexTailAnalysis = {
    sizeBytes: file.sizeBytes,
    updatedAtMs: file.updatedAtMs,
    overlapChunks: tail
      .split("\n")
      .flatMap((line) => extractJsonlStrings(line))
      .map(normalizeOverlapText)
      .filter((text) => text.length >= 8),
    modelSettings: latestCodexModelSettingsFromText(tail)
  };
  if (!codexTailAnalysisCache.has(file.path) && codexTailAnalysisCache.size >= CODEX_TAIL_ANALYSIS_CACHE_LIMIT) {
    const oldestPath = codexTailAnalysisCache.keys().next().value;
    if (oldestPath) codexTailAnalysisCache.delete(oldestPath);
  }
  codexTailAnalysisCache.set(file.path, analysis);
  return analysis;
}

async function readFileTail(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const length = Math.min(maxBytes, stat.size);
    const position = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function readLatestCodexModelSettings(file: CodexSessionFile): Promise<SessionModelSettings | null> {
  try {
    return (await readCodexTailAnalysis(file)).modelSettings;
  } catch {
    return null;
  }
}

const CODEX_FAST_MODE_SCAN_CHUNK_BYTES = 256 * 1024;
const CODEX_FAST_MODE_CACHE_LIMIT = 256;
const CODEX_FAST_MODE_EVENT_MARKER = Buffer.from('"thread_settings_applied"');
const codexFastModeFileCache = new Map<string, { size: number; mtimeMs: number; value: boolean | null }>();

async function readLatestCodexFastMode(path: string): Promise<boolean | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const fileStat = await file.stat();
    const cached = codexFastModeFileCache.get(path);
    if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) return cached.value;

    const start = cached && fileStat.size > cached.size ? cached.size : 0;
    const appendedValue = await readLatestCodexFastModeBetween(file, start, fileStat.size);
    const value = appendedValue ?? (start > 0 ? cached?.value ?? null : null);

    if (fileStat.size === 0 || await fileEndsWithNewline(file, fileStat.size)) {
      cacheCodexFastMode(path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, value });
    }
    return value;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

function cacheCodexFastMode(path: string, entry: { size: number; mtimeMs: number; value: boolean | null }): void {
  if (!codexFastModeFileCache.has(path) && codexFastModeFileCache.size >= CODEX_FAST_MODE_CACHE_LIMIT) {
    const oldestPath = codexFastModeFileCache.keys().next().value;
    if (oldestPath) codexFastModeFileCache.delete(oldestPath);
  }
  codexFastModeFileCache.set(path, entry);
}

async function readLatestCodexFastModeBetween(
  file: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number
): Promise<boolean | null> {
  let position = end;
  let lineParts: Buffer[] = [];
  while (position > start) {
    const length = Math.min(CODEX_FAST_MODE_SCAN_CHUNK_BYTES, position - start);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    const chunk = buffer.subarray(0, bytesRead);
    let lineEnd = chunk.length;
    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(index + 1, lineEnd);
      const line = lineParts.length > 0 ? Buffer.concat([segment, ...lineParts]) : segment;
      const fastMode = codexFastModeFromBuffer(line);
      if (fastMode !== null) return fastMode;
      lineParts = [];
      lineEnd = index;
    }
    lineParts.unshift(chunk.subarray(0, lineEnd));
  }
  return codexFastModeFromBuffer(Buffer.concat(lineParts));
}

function codexFastModeFromBuffer(line: Buffer): boolean | null {
  if (line.indexOf(CODEX_FAST_MODE_EVENT_MARKER) < 0) return null;
  return codexFastModeFromLine(line.toString("utf8"));
}

async function fileEndsWithNewline(file: Awaited<ReturnType<typeof open>>, size: number): Promise<boolean> {
  if (size === 0) return true;
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await file.read(byte, 0, 1, size - 1);
  return bytesRead === 1 && byte[0] === 0x0a;
}

export function latestCodexFastModeFromText(text: string): boolean | null {
  let latest: boolean | null = null;
  for (const line of text.split("\n")) {
    const fastMode = codexFastModeFromLine(line);
    if (fastMode !== null) latest = fastMode;
  }
  return latest;
}

function codexFastModeFromLine(line: string): boolean | null {
  if (!line.includes('"thread_settings_applied"')) return null;
  try {
    const event = JSON.parse(line) as {
      payload?: { type?: unknown; thread_settings?: { service_tier?: unknown } };
    };
    if (event.payload?.type !== "thread_settings_applied") return null;
    return serviceTierFastMode(stringValue(event.payload.thread_settings?.service_tier));
  } catch {
    return null;
  }
}

async function readLiveCodexModelSettings(
  pane: TmuxPane,
  capturePane: (paneId: string, lines: number) => Promise<string>
): Promise<SessionModelSettings | null> {
  try {
    return codexModelSettingsFromPaneText(await capturePane(pane.paneId, 40));
  } catch {
    return null;
  }
}

export function codexModelSettingsFromPaneText(text: string): SessionModelSettings | null {
  let latest: SessionModelSettings | null = null;
  const effortPattern = "minimal|low|medium|high|xhigh|none";
  const bannerPattern = new RegExp(
    `^\\s*[│┃|]?\\s*model:\\s+([a-z0-9][a-z0-9._-]*)\\s+(${effortPattern})\\b.*\\/model\\b`,
    "i"
  );
  const statusLinePattern = new RegExp(
    `^\\s*([a-z0-9][a-z0-9._-]*)\\s+(${effortPattern})\\s*[·•]\\s*(?:~|/|[a-z]:[\\\\/])`,
    "i"
  );

  for (const line of text.split("\n")) {
    const match = bannerPattern.exec(line) ?? statusLinePattern.exec(line);
    if (!match) continue;
    const model = match[1];
    const reasoningEffort = match[2];
    if (!model || !reasoningEffort) continue;
    latest = { model, reasoningEffort: reasoningEffort.toLowerCase() };
  }
  return latest;
}

function latestCodexModelSettingsFromText(text: string): SessionModelSettings | null {
  let latest: SessionModelSettings | null = null;
  for (const line of text.split("\n")) {
    const settings = codexModelSettingsFromLine(line);
    if (settings) latest = settings;
  }
  return latest;
}

function codexModelSettingsFromLine(line: string): SessionModelSettings | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      payload?: {
        model?: unknown;
        effort?: unknown;
        reasoning_effort?: unknown;
        collaboration_mode?: {
          settings?: {
            model?: unknown;
            reasoning_effort?: unknown;
          };
        };
      };
    };
    const payload = event.payload;
    if (!payload) return null;
    const collaborationSettings = payload.collaboration_mode?.settings;
    const model = stringValue(collaborationSettings?.model) ?? stringValue(payload.model);
    const reasoningEffort =
      stringValue(collaborationSettings?.reasoning_effort) ?? stringValue(payload.reasoning_effort) ?? stringValue(payload.effort);
    if (!model && !reasoningEffort) return null;
    return { model, reasoningEffort };
  } catch {
    return null;
  }
}

function extractJsonlStrings(line: string): string[] {
  if (!line.trim()) return [];
  try {
    const event = JSON.parse(line) as {
      payload?: {
        message?: unknown;
        output?: unknown;
        content?: unknown;
      };
    };
    const values = [event.payload?.message, event.payload?.output, contentText(event.payload?.content)];
    return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    return [];
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (item && typeof item === "object" && "text" in item) return String((item as { text: unknown }).text);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeOverlapText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parserOffsetKey(sessionId: string, source: string): string {
  return `${sessionId}:${source}`;
}

export function tmuxPaneSessionId(pane: TmuxPane): string {
  const legacyIdentity = `${pane.sessionId}:${pane.windowId}:${pane.paneId}`;
  if (!pane.serverPid || !pane.sessionCreatedAt) return stableId(legacyIdentity);
  return stableId(`${pane.serverPid}:${pane.sessionCreatedAt}:${legacyIdentity}`);
}

export function legacyTmuxPaneSessionId(pane: TmuxPane): string {
  return stableId(`${pane.sessionId}:${pane.windowId}:${pane.paneId}`);
}

function sameLivePaneProcess(session: ManagedSession, pane: TmuxPane): boolean {
  return session.tmux.pid > 0 && session.tmux.pid === pane.pid;
}

export function sessionChanged(previous: ManagedSession, next: ManagedSession): boolean {
  return JSON.stringify(sessionDiscoverySnapshot(previous)) !== JSON.stringify(sessionDiscoverySnapshot(next));
}

function sessionDiscoverySnapshot(session: ManagedSession): Record<string, unknown> {
  return {
    tmux: session.tmux,
    repo: session.repo,
    codexSessionId: session.codexSessionId,
    codexJsonlPath: session.codexJsonlPath,
    discoveryConfidence: session.discoveryConfidence,
    status: session.status,
    initializing: session.initializing === true,
    startupError: session.startupError ?? null,
    lastActivityAt: session.lastActivityAt,
    transcriptSyncing: session.transcriptSyncing === true,
    inputMode: session.inputMode,
    models: session.models,
    fastMode: session.fastMode ?? null,
    fastModeAvailable: session.fastModeAvailable ?? null,
    pinned: session.pinned,
    archived: session.archived,
    forkedFrom: session.forkedFrom ?? null,
    gitWorkspace: session.gitWorkspace
  };
}

interface IngestTarget {
  session: ManagedSession;
  sourceUpdatedAtMs: number | null;
}

function compareIngestTargets(first: IngestTarget, second: IngestTarget): number {
  const firstSource = first.sourceUpdatedAtMs ?? Number.NEGATIVE_INFINITY;
  const secondSource = second.sourceUpdatedAtMs ?? Number.NEGATIVE_INFINITY;
  if (firstSource !== secondSource) return secondSource - firstSource;

  const firstActivity = first.session.lastActivityAt ? Date.parse(first.session.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const secondActivity = second.session.lastActivityAt ? Date.parse(second.session.lastActivityAt) : Number.NEGATIVE_INFINITY;
  if (firstActivity !== secondActivity) return secondActivity - firstActivity;

  return first.session.id.localeCompare(second.session.id);
}

async function sessionSourceMetadata(session: ManagedSession): Promise<{ sizeBytes: number | null; updatedAtMs: number | null }> {
  if (!session.codexJsonlPath) return { sizeBytes: null, updatedAtMs: null };
  try {
    const details = await stat(session.codexJsonlPath);
    return { sizeBytes: details.size, updatedAtMs: details.mtimeMs };
  } catch {
    return { sizeBytes: null, updatedAtMs: null };
  }
}

function emptySessionModels(): SessionModelSelections {
  return { default: emptySessionModelSettings(), plan: emptySessionModelSettings() };
}

function emptySessionModelSettings(): SessionModelSettings {
  return { model: null, reasoningEffort: null };
}

function activeSessionModel(models: SessionModelSelections, mode: CollaborationMode): string | null {
  return models[mode].model ?? models.default.model ?? models.plan.model;
}

function codexFastModeAvailable(models: CodexModel[], activeModel: string | null): boolean | null {
  if (!activeModel || models.length === 0) return null;
  const model = models.find((candidate) => candidate.model === activeModel || candidate.id === activeModel);
  if (!model) return null;
  return model.serviceTiers.some((tier) => {
    const id = tier.id.toLowerCase();
    return id === "fast" || id === "priority";
  });
}

function serviceTierFastMode(serviceTier: string | null): boolean | null {
  if (!serviceTier) return null;
  const normalized = serviceTier.toLowerCase();
  if (normalized === "fast" || normalized === "priority") return true;
  if (normalized === "default" || normalized === "standard") return false;
  return null;
}

function mergeSessionModels(
  existing: SessionModelSelections | undefined,
  mode: CollaborationMode,
  liveSettings: SessionModelSettings | null
): SessionModelSelections {
  const models = existing ?? emptySessionModels();
  if (!liveSettings?.model && !liveSettings?.reasoningEffort) return models;
  return {
    ...models,
    [mode]: {
      ...models[mode],
      ...(liveSettings.model ? { model: liveSettings.model } : {}),
      ...(liveSettings.reasoningEffort ? { reasoningEffort: liveSettings.reasoningEffort } : {})
    }
  };
}

function mergeModelSettings(
  fallback: SessionModelSettings | null,
  current: SessionModelSettings | null
): SessionModelSettings | null {
  if (!fallback && !current) return null;
  return {
    model: current?.model ?? fallback?.model ?? null,
    reasoningEffort: current?.reasoningEffort ?? fallback?.reasoningEffort ?? null
  };
}

function detectCollaborationModeFromPane(pane: TmuxPane): CollaborationMode | null {
  return detectCollaborationModeFromText(`${pane.title}\n${pane.windowName}`);
}

async function detectLiveCollaborationMode(
  pane: TmuxPane,
  capturePane: (paneId: string, lines: number) => Promise<string>
): Promise<CollaborationMode | null> {
  const paneMode = detectCollaborationModeFromPane(pane);
  if (paneMode) return paneMode;
  try {
    return detectCollaborationModeFromText(await capturePane(pane.paneId, 30));
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectCollaborationModeFromText(text: string): CollaborationMode | null {
  const lines = text
    .split("\n")
    .map((line) => line.toLowerCase().replace(/[_-]+/g, " ").trim())
    .filter(Boolean);
  if (lines.some((line) => /^›\s*plan\b/.test(line) || line === "plan mode" || line.startsWith("plan mode prompt:"))) return "plan";
  if (lines.some((line) => line === "normal mode" || line === "default mode")) return "default";
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeCodexPane(pane: TmuxPane): boolean {
  const haystack = `${pane.title} ${pane.windowName} ${pane.currentCommand}`.toLowerCase();
  return haystack.includes("codex") || haystack.includes("action required") || haystack.includes("plan mode");
}

function looksLikeCodexScreen(capture: string): boolean {
  const haystack = capture.toLowerCase();
  return (
    haystack.includes("openai codex") ||
    haystack.includes("use /skills to list available skills") ||
    haystack.includes("context ") ||
    haystack.includes("plan mode") ||
    haystack.includes("gpt-") ||
    haystack.includes("press enter to confirm") ||
    haystack.includes("would you like to run")
  );
}

function looksLikeApprovalScreen(capture: string): boolean {
  const visible = visibleTail(capture);
  if (parseInteractiveApprovalPrompt(visible)) return true;
  const haystack = visible.toLowerCase();
  return (
    haystack.includes("approval required") ||
    haystack.includes("ask for approval") ||
    haystack.includes("allow and don't ask") ||
    haystack.includes("don't ask again") ||
    haystack.includes("run the command") ||
    haystack.includes("run this command") ||
    (haystack.includes("yes, proceed") && haystack.includes("press enter to confirm")) ||
    haystack.includes("would you like to run")
  );
}

async function inferStatus(
  pane: TmuxPane,
  previous: SessionStatus | undefined,
  capturePane: (paneId: string, lines: number) => Promise<string>
): Promise<SessionStatus> {
  const titleStatus = inferStatusFromTitle(pane);

  try {
    const capture = await capturePane(pane.paneId, 100);
    const screenStatus = inferStatusFromScreen(capture);
    if (screenStatus === "approval") return screenStatus;
    if (titleStatus === "working") return titleStatus;
    if (screenStatus) return screenStatus;
    if (titleStatus) return titleStatus;
    if (looksLikeCodexScreen(capture)) return "waiting";
  } catch {
    // Fall back to tmux metadata when pane capture is unavailable.
  }

  if (titleStatus) return titleStatus;
  if (previous && previous !== "missing" && previous !== "approval") return previous;
  return "unknown";
}

function inferStatusFromTitle(pane: TmuxPane): SessionStatus | null {
  const title = pane.title.toLowerCase();
  if (title.includes("working") || title.includes("running") || /[\u2800-\u28ff]/u.test(pane.title)) return "working";
  if (looksLikeBlockedStatus(title)) return "blocked";
  if (title.includes("waiting")) return "waiting";
  return null;
}

function rejectedApprovalFallbackStatus(pane: TmuxPane, previous: SessionStatus | undefined): SessionStatus {
  const titleStatus = inferStatusFromTitle(pane);
  if (titleStatus && titleStatus !== "approval") return titleStatus;
  if (previous && previous !== "approval" && previous !== "missing") return previous;
  return "waiting";
}

function startupReadyStatus(status: SessionStatus | undefined): SessionStatus {
  if (!status || status === "unknown" || status === "missing" || status === "startup_failed") return "waiting";
  return status;
}

function inferStatusFromScreen(capture: string): SessionStatus | null {
  if (isCodexStartupFailureCapture(capture)) return "startup_failed";
  const visible = visibleTail(capture);
  if (parseInteractiveApprovalPrompt(capture)) return "approval";
  const lines = visible.split("\n");
  const latestWorkingLine = lines.findLastIndex((line) => {
    const normalized = line.toLowerCase();
    return normalized.includes("working (") || normalized.includes("esc to interrupt");
  });
  const latestComposerLine = lines.findLastIndex((line) => /^\s*›(?!\s*\d+\.)/.test(line));
  if (latestComposerLine > latestWorkingLine) return "waiting";
  if (latestWorkingLine >= 0) return "working";
  if (looksLikeApprovalScreen(visible)) return "approval";
  if (looksLikeBlockedStatus(visible)) return "blocked";
  return null;
}

function visibleTail(text: string): string {
  return text.trimEnd().split("\n").slice(-30).join("\n");
}

function looksLikeBlockedStatus(text: string): boolean {
  return /(^|\n)\s*(?:[│┃|>›·•*-]\s*)?(?:status:\s*)?blocked(?:\s*(?:$|\n|\(|:|-))/i.test(text);
}

function requireSession(session: ManagedSession | null): ManagedSession {
  if (!session) throw new Error("Session not found");
  if (session.status === "missing") throw new Error("Session is no longer available in tmux");
  return session;
}

async function requireExistingDirectory(cwd: string): Promise<string> {
  const path = await existingDirectoryPath(cwd);
  if (!path) throw new CreateSessionError("Directory does not exist or is not accessible", 400);
  return path;
}

async function existingDirectoryPath(cwd: string): Promise<string | null> {
  try {
    const path = await realpath(cwd);
    const info = await stat(path);
    return info.isDirectory() ? path : null;
  } catch {
    return null;
  }
}

async function directorySuggestionFromPath(
  candidate: string,
  source: SessionDirectorySuggestion["source"],
  lastActivityAt: string | null,
  fallback: Partial<Pick<SessionDirectorySuggestion, "label" | "repoRoot" | "branch">> = {}
): Promise<SessionDirectorySuggestion | null> {
  const path = await existingDirectoryPath(candidate);
  if (!path) return null;
  const repo = await loadRepoMetadata(path);
  return {
    path,
    label: repo.name || fallback.label || basename(path),
    repoRoot: repo.root ?? fallback.repoRoot ?? null,
    branch: repo.branch ?? fallback.branch ?? null,
    source,
    lastActivityAt
  };
}

function mergeDirectorySuggestion(
  current: SessionDirectorySuggestion | undefined,
  next: SessionDirectorySuggestion
): SessionDirectorySuggestion {
  if (!current) return next;
  const source = current.source === "active" || next.source === "active" ? "active" : "recent";
  const currentTime = current.lastActivityAt ? Date.parse(current.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const nextTime = next.lastActivityAt ? Date.parse(next.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const fresher = nextTime > currentTime ? next : current;
  return {
    ...fresher,
    source,
    lastActivityAt: fresher.lastActivityAt ?? current.lastActivityAt ?? next.lastActivityAt
  };
}

function compareDirectorySuggestions(first: SessionDirectorySuggestion, second: SessionDirectorySuggestion): number {
  if (first.source !== second.source) return first.source === "active" ? -1 : 1;
  const firstTime = first.lastActivityAt ? Date.parse(first.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const secondTime = second.lastActivityAt ? Date.parse(second.lastActivityAt) : Number.NEGATIVE_INFINITY;
  if (firstTime !== secondTime) return secondTime - firstTime;
  return first.label.localeCompare(second.label) || first.path.localeCompare(second.path);
}

function materializeApproval(message: ChatMessage): ApprovalRequest | null {
  const approval = recordValue(message.payload.approval);
  if (!approval) return null;
  const id = stringValue(approval.id) ?? message.id;
  const kind = approvalKind(approval.kind);
  const title = stringValue(approval.title) ?? "Approval required";
  const prefixRule = stringArray(approval.prefixRule);
  return {
    id,
    sessionId: message.sessionId,
    messageId: message.id,
    kind,
    title,
    command: stringValue(approval.command),
    toolName: stringValue(approval.toolName),
    cwd: stringValue(approval.cwd),
    reason: stringValue(approval.reason),
    prefixRule,
    options: approvalOptions(approval.options, prefixRule),
    createdAt: stringValue(approval.createdAt) ?? message.timestamp
  };
}

function materializeInteractiveApproval(
  session: ManagedSession,
  prompt: InteractiveApprovalPrompt,
  latestMessage: ChatMessage | null
): ApprovalRequest {
  const toolCall = latestMessage?.type === "tool_call" ? recordValue(latestMessage.payload.payload) : null;
  const callId = stringValue(toolCall?.call_id);
  const toolName = prompt.kind === "permissions" ? toolCallName(toolCall) : null;
  const id =
    callId ??
    stableId(
      `${session.id}:${prompt.kind}:${prompt.title}:${prompt.command ?? ""}:${prompt.reason ?? ""}:${prompt.prefixRule?.join(" ") ?? ""}:${prompt.options
        .map((option) => option.decision)
        .join(":")}`
    );
  return {
    id,
    sessionId: session.id,
    messageId: latestMessage?.id ?? id,
    kind: prompt.kind,
    title: prompt.title,
    command: prompt.command,
    toolName,
    cwd: null,
    reason: prompt.reason,
    prefixRule: prompt.prefixRule,
    options: prompt.options.map(({ decision, label, description }) => ({ decision, label, description })),
    createdAt: latestMessage?.timestamp ?? nowIso()
  };
}

function interactiveApprovalMatches(approval: ApprovalRequest, prompt: InteractiveApprovalPrompt): boolean {
  return (
    approval.kind === prompt.kind &&
    approval.title === prompt.title &&
    approval.command === prompt.command &&
    approval.reason === prompt.reason &&
    stringArraysEqual(approval.prefixRule, prompt.prefixRule) &&
    approval.options.map((option) => option.decision).join(":") === prompt.options.map((option) => option.decision).join(":")
  );
}

function interactiveApprovalHasTranscriptContext(
  prompt: InteractiveApprovalPrompt,
  latestMessage: ChatMessage | null
): boolean {
  if (!latestMessage || latestMessage.type !== "tool_call") return false;
  const payload = recordValue(latestMessage.payload.payload);
  if (!payload) return false;
  if (payload.type === "function_call") {
    if (prompt.kind === "permissions") return true;
    const name = stringValue(payload.name)?.replace(/^_+/, "");
    if (prompt.kind === "patch") return name === "apply_patch";
    return prompt.kind === "command" && name === "exec_command";
  }
  if (payload.type !== "custom_tool_call" || payload.name !== "exec") return false;
  const input = stringValue(payload.input);
  if (prompt.kind === "permissions") return toolCallName(payload)?.startsWith("codex_apps.") ?? false;
  if (prompt.kind === "patch") return Boolean(input && /tools\.apply_patch\s*\(/.test(input));
  if (prompt.kind !== "command") return false;
  if (!input || !/tools\.exec_command\s*\(/.test(input)) return false;
  if (/["']?sandbox_permissions["']?\s*:\s*["']require_escalated["']/.test(input)) return true;
  return nestedExecCommandMatchesPrompt(input, prompt);
}

function nestedExecCommandMatchesPrompt(input: string, prompt: InteractiveApprovalPrompt): boolean {
  const command = nestedExecCommand(input);
  if (!command) return false;
  const normalizedCommand = normalizeCommandText(command);
  const visibleCommands = [prompt.prefixRule?.join(" ") ?? null, prompt.command]
    .filter((candidate): candidate is string => Boolean(candidate));
  return visibleCommands.some((visibleCommand) => commandMatchesVisibleText(normalizedCommand, visibleCommand));
}

function commandMatchesVisibleText(normalizedCommand: string, visibleCommand: string): boolean {
  const minElidedCommandContextLength = 16;
  const normalizedVisibleCommand = normalizeCommandText(visibleCommand);
  if (
    normalizedCommand === normalizedVisibleCommand ||
    normalizedCommand.startsWith(`${normalizedVisibleCommand} `)
  ) {
    return true;
  }

  const elisionPattern = /(?:\u2026|\.{3,})/u;
  if (!elisionPattern.test(normalizedVisibleCommand)) return false;
  const fragments = normalizedVisibleCommand
    .split(elisionPattern)
    .map(normalizeCommandText)
    .filter(Boolean);
  if (fragments.reduce((length, fragment) => length + fragment.length, 0) < minElidedCommandContextLength) return false;

  let cursor = 0;
  for (const [index, fragment] of fragments.entries()) {
    const fragmentIndex = normalizedCommand.indexOf(fragment, cursor);
    if (fragmentIndex < 0 || index === 0 && fragmentIndex !== 0) return false;
    cursor = fragmentIndex + fragment.length;
  }
  return /(?:\u2026|\.{3,})$/u.test(normalizedVisibleCommand) || cursor === normalizedCommand.length;
}

function nestedExecCommand(input: string): string | null {
  const callIndex = input.lastIndexOf("tools.exec_command");
  if (callIndex < 0) return null;
  const call = input.slice(callIndex);
  const match = call.match(/(?:["']cmd["']|\bcmd)\s*:\s*(["'])((?:\\[\s\S]|(?!\1)[\s\S])*)\1/);
  if (!match?.[1] || match[2] === undefined) return null;
  try {
    if (match[1] === '"') return JSON.parse(`"${match[2]}"`) as string;
    return match[2].replace(/\\([\\'])/g, "$1").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  } catch {
    return null;
  }
}

function normalizeCommandText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stringArraysEqual(first: string[] | null, second: string[] | null): boolean {
  if (first === null || second === null) return first === second;
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function toolCallName(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  if (payload.type === "function_call") {
    const name = stringValue(payload.name)?.replace(/^_+/, "") ?? null;
    const namespace = stringValue(payload.namespace)
      ?.replace(/^mcp__codex_apps__/, "codex_apps.")
      .replace(/__/g, ".");
    if (namespace && name) return `${namespace}.${name}`;
    return name ?? namespace ?? null;
  }
  if (payload.type !== "custom_tool_call" || payload.name !== "exec") return null;
  const input = stringValue(payload.input);
  const nestedAppCall = input?.match(/tools\.mcp__codex_apps__([A-Za-z0-9]+)_([A-Za-z0-9_]+)\s*\(/);
  if (!nestedAppCall?.[1] || !nestedAppCall[2]) return null;
  return `codex_apps.${nestedAppCall[1]}.${nestedAppCall[2]}`;
}

function approvalOptions(value: unknown, prefixRule: string[] | null): ApprovalRequest["options"] {
  if (Array.isArray(value)) {
    const options = value.map(approvalOption).filter((option): option is ApprovalRequest["options"][number] => Boolean(option));
    if (options.length > 0) return options;
  }
  return [
    { decision: "approve_once", label: "Approve once", description: "Run this tool call and continue." },
    ...(prefixRule
      ? [{ decision: "approve_for_prefix" as const, label: "Always allow prefix", description: "Remember this command prefix." }]
      : []),
    { decision: "deny", label: "Deny", description: "Cancel this tool call." }
  ];
}

function approvalOption(value: unknown): ApprovalRequest["options"][number] | null {
  const option = recordValue(value);
  if (!option) return null;
  const decision = approvalDecision(option.decision);
  const label = stringValue(option.label);
  if (!decision || !label) return null;
  return { decision, label, description: stringValue(option.description) ?? "" };
}

function approvalDecision(value: unknown): ApprovalDecision | null {
  if (
    value === "approve_once" ||
    value === "approve_for_session" ||
    value === "approve_always" ||
    value === "approve_for_prefix" ||
    value === "deny"
  ) {
    return value;
  }
  return null;
}

function materializeQuestion(message: ChatMessage): QuestionRequest | null {
  const question = recordValue(message.payload.question);
  if (!question) return null;
  const prompts = questionPrompts(question.questions);
  if (!prompts) return null;
  return {
    id: stringValue(question.id) ?? message.id,
    sessionId: message.sessionId,
    messageId: message.id,
    questions: prompts,
    autoResolutionMs: numberValue(question.autoResolutionMs),
    createdAt: stringValue(question.createdAt) ?? message.timestamp,
    expiresAt: stringValue(question.expiresAt),
    countdownStartedAt: stringValue(question.countdownStartedAt),
    countdownExpiresAt: stringValue(question.countdownExpiresAt)
  };
}

function questionPrompts(value: unknown): QuestionRequest["questions"] | null {
  if (!Array.isArray(value)) return null;
  const prompts = value.map(questionPrompt).filter((item): item is QuestionRequest["questions"][number] => Boolean(item));
  return prompts.length > 0 ? prompts : null;
}

function questionPrompt(value: unknown): QuestionRequest["questions"][number] | null {
  const item = recordValue(value);
  if (!item) return null;
  const id = stringValue(item.id);
  const question = stringValue(item.question);
  if (!id || !question) return null;
  return {
    id,
    header: stringValue(item.header) ?? "",
    question,
    options: questionOptions(item.options)
  };
}

function questionOptions(value: unknown): QuestionRequest["questions"][number]["options"] {
  if (!Array.isArray(value)) return [];
  return value.map(questionOption).filter((item): item is QuestionRequest["questions"][number]["options"][number] => Boolean(item));
}

function questionOption(value: unknown): QuestionRequest["questions"][number]["options"][number] | null {
  const item = recordValue(value);
  if (!item) return null;
  const label = stringValue(item.label);
  if (!label) return null;
  return {
    label,
    description: stringValue(item.description) ?? ""
  };
}

function normalizeQuestionAnswer(question: QuestionRequest, request: QuestionAnswerRequest): QuestionAnswerRequest {
  const questionIds = new Set(question.questions.map((item) => item.id));
  const requestIds = Object.keys(request.answers);
  const unknownId = requestIds.find((id) => !questionIds.has(id));
  if (unknownId) throw new QuestionResolutionError(`Unknown question id: ${unknownId}`);

  const answers: QuestionAnswerRequest["answers"] = {};
  for (const prompt of question.questions) {
    const answer = request.answers[prompt.id];
    if (!answer) throw new QuestionResolutionError(`Missing answer for question: ${prompt.id}`);
    const values = answer.answers.map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) throw new QuestionResolutionError(`Answer is required for question: ${prompt.id}`);
    answers[prompt.id] = { answers: values };
  }

  return { answers };
}

function approvalKind(value: unknown): ApprovalRequest["kind"] {
  if (value === "command" || value === "tool" || value === "patch" || value === "permissions") return value;
  return "tool";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function withQuestionCountdown(message: ChatMessage): ChatMessage {
  if (message.type !== "question_request") return message;
  const question = recordValue(message.payload.question);
  if (!question) return message;
  const autoResolutionMs = numberValue(question.autoResolutionMs);
  if (autoResolutionMs === null) {
    return {
      ...message,
      payload: {
        ...message.payload,
        question: {
          ...question,
          countdownStartedAt: null,
          countdownExpiresAt: null
        }
      }
    };
  }

  const countdownStartedAt = nowIso();
  return {
    ...message,
    payload: {
      ...message.payload,
      question: {
        ...question,
        countdownStartedAt,
        countdownExpiresAt: timestampPlusMs(countdownStartedAt, autoResolutionMs)
      }
    }
  };
}

function timestampPlusMs(timestamp: string, ms: number): string | null {
  const start = new Date(timestamp).getTime();
  if (!Number.isFinite(start)) return null;
  return new Date(start + ms).toISOString();
}

async function atomicWrite(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.muxpilot-import-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

function compareTranscripts(first: Buffer, second: Buffer): number {
  const firstTimestamp = latestTranscriptTimestamp(first);
  const secondTimestamp = latestTranscriptTimestamp(second);
  return firstTimestamp === secondTimestamp ? first.length - second.length : firstTimestamp - secondTimestamp;
}

function completeTranscriptPrefix(transcript: Buffer): Buffer {
  if (transcript.length === 0 || transcript[transcript.length - 1] === 0x0a) return transcript;
  const newline = transcript.lastIndexOf(0x0a);
  return newline < 0 ? transcript : transcript.subarray(0, newline + 1);
}

function latestTranscriptTimestamp(transcript: Buffer): number {
  const lines = transcript.toString("utf8").trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]!) as { timestamp?: string };
      const timestamp = Date.parse(value.timestamp ?? "");
      if (Number.isFinite(timestamp)) return timestamp;
    } catch {
      // A running transcript may end with a partial line; inspect earlier events.
    }
  }
  return 0;
}
