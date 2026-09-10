import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  AgentSessionOwnership,
  ApprovalMode,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalReviewerSettings,
  ChatMessage,
  CodexModel,
  CodexModelCatalogResponse,
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
  SessionCapabilities,
  SessionDocumentResponse,
  SessionDocumentsResponse,
  SessionDirectorySuggestion,
  SessionModelSettings,
  SessionModelSelections,
  SessionStatus,
  SessionTransferImportMapping,
  SessionTransferImportResult,
  TranscriptPageResponse,
  TranscriptSearchResponse
} from "@muxpilot/core";
import { canToggleFastMode, hasCompleteProposedPlan, highestPrioritySession, isValidSessionName, normalizeGitWorkspaceSummary, normalizeSessionName, sessionHistoryIdentity } from "@muxpilot/core";
import type { AppDatabase, StoredGitWorkspace } from "../db/database.js";
import { CodexSessionStore, type CodexSessionFile } from "../codex/codexSessionStore.js";
import { PARSER_VERSION, appendSkillNamesForDisplay, parseCodexJsonl } from "../codex/parser.js";
import type { AgentSessionDriver, AgentSessionLaunchOptions, AgentSessionLaunchResult, DriverInputReceipt, McpServerLaunchConfig } from "./sessionDrivers/types.js";
import type { SessionDriverRegistry } from "./sessionDrivers/registry.js";
import {
  AppServerSteerUnavailableError,
  PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX,
  PLAN_IMPLEMENTATION_MESSAGE
} from "./sessionDrivers/codexAppServerDriver.js";
import { eventId, stableId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { loadRepoMetadata } from "./gitMetadata.js";
import type { EventBus } from "./eventBus.js";
import { reusableDependencyLinks, statusPath, type GitWorkspaceManager } from "./gitWorkspaceManager.js";
import { accountAgentWorkTokens, agentWorkTokensUsed } from "./agentUsage.js";
import type { PortableSession } from "./sessionTransfer.js";
import { isMuxpilotSessionResourceUnit, isMuxpilotSessionScope, sessionScopeName } from "./sessionScopes.js";
import {
  SessionDocumentService,
  type BtwDocumentApplyResult,
  type BtwDocumentChanges,
  type SessionDocumentSnapshot
} from "./sessionDocuments.js";
import type { ApprovalReviewResult } from "./approvalReviewer.js";

interface ApprovalReviewProvider {
  review(session: ManagedSession, approval: ApprovalRequest, settings: ApprovalReviewerSettings): Promise<ApprovalReviewResult>;
  stop(): void;
}

interface TranscriptInteractionOutcome {
  kind: "plan" | "approval" | "question";
  status: "answered" | "failed" | "closed";
  submittedAt: string;
  decision?: PlanActionChoice | ApprovalDecision;
  answers?: QuestionAnswerRequest["answers"];
  error?: string;
  resolvedBy?: "user" | "auto" | "full";
  reviewerModel?: string;
  reviewerExplanation?: string;
}

interface CodexMetadataLookup {
  listModels(): Promise<CodexModel[]>;
  catalog(): Promise<CodexModelCatalogResponse>;
  effectiveServiceTier(cwd: string): Promise<string | null>;
}

interface SessionManagerStartOptions {
  runInitialTick?: boolean;
}

interface SessionResourceUsageLookup {
  usageForSession(sessionId: string): SessionResourceUsage | null;
}

interface HeavyCommandQueueLookup {
  hasActive(workspaceId: string): Promise<boolean>;
  sessionStatusForWorkspace(workspaceId: string): Promise<"queued" | "running" | "working" | null>;
  cancelWorkspace(workspaceId: string, reason: string): Promise<void>;
}

interface SessionOrchestrationProvider {
  prepareLaunch(): Promise<{ capabilityId: string; server: McpServerLaunchConfig }>;
  bindCapability(capabilityId: string, sessionId: string): Promise<void>;
}

interface IngestSessionResult {
  incomplete: boolean;
  progressed: boolean;
}

const MAX_LIVE_INGEST_PASSES_PER_TICK = 8;
const PLAN_ACTION_START_GRACE_MS = 15_000;
const INPUT_DELIVERY_ACK_TIMEOUT_MS = 30_000;
const AGENT_DESCENDANT_LIMIT = 2;
const DEFAULT_AGENT_WORK_TOKEN_BUDGET = 1_000_000;
const AGENT_SCOPE_UNAVAILABLE_MESSAGE = "Independent agent-session resource scopes are unavailable. Run sudo loginctl enable-linger $USER, restart muxpilot, and restore the session before retrying.";
const HEAVY_COMMAND_STATUS_BLOCKERS = new Set<SessionStatus>([
  "approval",
  "question",
  "plan_ready",
  "blocked",
  "input_failed",
  "startup_failed",
  "missing",
  "unknown"
]);
const STEERABLE_SESSION_STATUSES = new Set<SessionStatus>([
  "working",
  "generating",
  "executing",
  "running",
  "planning"
]);
type InputDeliveryIntent = "auto" | "steer";
type InputDeliveryFailureCode =
  | "no_codex_acknowledgement"
  | "session_unavailable"
  | "app_server_rejected";

export class SessionManager {
  private discoveryTimer: NodeJS.Timeout | null = null;
  private parserTimer: NodeJS.Timeout | null = null;
  private appServerHibernateTimer: NodeJS.Timeout | null = null;
  private discoveryRunning = false;
  private ingestRunning = false;
  private readonly answeredPlanMessageIds = new Set<string>();
  private readonly answeredQuestionMessageIds = new Set<string>();
  private readonly pendingPlanActionStatuses = new Map<string, { status: SessionStatus; expiresAtMs: number }>();
  private readonly processingQueuedSessionIds = new Set<string>();
  private readonly deliveringInputSessionIds = new Set<string>();
  private readonly liveApprovals = new Map<string, ApprovalRequest>();
  private readonly resolvingRepositoryApprovals = new Map<string, string>();
  private readonly readySessionDiscoveryGeneration = new Map<string, number>();
  private discoveryGeneration = 0;
  private codexFileObservations = new Map<string, { sizeBytes: number; updatedAtMs: number }>();
  private missingIngestCursor = 0;
  private resourceUsageLookup: SessionResourceUsageLookup | null = null;
  private heavyCommandQueue: HeavyCommandQueueLookup | null = null;
  private orchestrationProvider: SessionOrchestrationProvider | null = null;
  private recoveryRunId: string | null = null;
  private startupRecoveryCandidates: SessionRecoveryCandidate[] = [];
  private readonly restoreLocks = new Map<string, Promise<unknown>>();
  private agentMutationQueue = Promise.resolve();
  private appServerRecoveryRunning = false;
  private appServerHibernationRunning = false;
  private readonly runtimeOperationTails = new Map<string, Promise<void>>();
  private readonly automatedApprovalMessageIds = new Set<string>();

  constructor(
    private readonly db: AppDatabase,
    private readonly codexStore: CodexSessionStore,
    private readonly events: EventBus,
    private readonly discoveryIntervalMs: number,
    private readonly parserIntervalMs: number,
    private readonly documents: SessionDocumentService,
    private readonly approvalReviewer: ApprovalReviewProvider | null = null,
    private readonly gitWorkspaces: GitWorkspaceManager | null = null,
    private readonly codexHome: string | null = process.env.CODEX_HOME ?? null,
    private readonly gitWorktreeRoot: string | null = null,
    private readonly managedEnvironment: Record<string, string> = {},
    private readonly codexMetadata: CodexMetadataLookup | null = null,
    private readonly sessionDrivers: SessionDriverRegistry | null = null,
    private readonly appServerHibernateMs = 900_000,
    private readonly imagePath: ((sessionId: string, imageId: string) => string) | null = null
  ) {}

  start(options: SessionManagerStartOptions = {}): void {
    this.runBackgroundTask("app-server recovery", () => this.recoverAppServerSessions());
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
    const hibernateIntervalMs = Math.min(60_000, Math.max(1_000, Math.floor(this.appServerHibernateMs / 3)));
    this.appServerHibernateTimer = setInterval(
      () => this.runBackgroundTask("app-server hibernation", () => this.hibernateIdleAppServerSessions()),
      hibernateIntervalMs
    );
    this.appServerHibernateTimer.unref();
  }

  async reconcileNow(): Promise<void> {
    await this.runDiscoverTick();
    await this.runIngestTick();
  }

  async recoverAppServerSessions(): Promise<void> {
    if (this.appServerRecoveryRunning) return;
    this.appServerRecoveryRunning = true;
    try {
      const sessions = (await this.db.listSessions(true))
        .filter(isRecoverableAppServerSession)
        .sort(compareAppServerRecoveryOrder);
      if (!this.sessionDrivers?.has("codex_app_server")) {
        for (const session of sessions) {
          await this.markAppServerRecoveryFailed(session.id, "App-server runtime compatibility is unavailable", false);
        }
        return;
      }
      for (const session of sessions) {
        try {
          await this.resumeAppServerSession(session);
        } catch (error) {
          console.error(`Muxpilot app-server recovery failed for ${session.id}`, error);
        }
      }
    } finally {
      this.appServerRecoveryRunning = false;
    }
  }

  setResourceUsageLookup(lookup: SessionResourceUsageLookup | null): void {
    this.resourceUsageLookup = lookup;
  }

  setHeavyCommandQueue(lookup: HeavyCommandQueueLookup | null): void {
    this.heavyCommandQueue = lookup;
  }

  setOrchestrationProvider(provider: SessionOrchestrationProvider | null): void {
    this.orchestrationProvider = provider;
  }

  async listDocuments(sessionId: string): Promise<SessionDocumentsResponse> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new SessionNotFoundError("Session not found");
    const scopeId = await this.ensureDocumentScope(session);
    return this.requireDocuments().list(scopeId);
  }

  async readDocument(sessionId: string, name: string): Promise<SessionDocumentResponse> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new SessionNotFoundError("Session not found");
    const scopeId = await this.ensureDocumentScope(session);
    return this.requireDocuments().read(scopeId, name);
  }

  async snapshotDocuments(sessionId: string): Promise<SessionDocumentSnapshot[]> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new SessionNotFoundError("Session not found");
    return this.requireDocuments().snapshot(await this.ensureDocumentScope(session));
  }

  async prepareBtwDocumentStaging(sessionId: string, exchangeId: string): Promise<{ documentsRoot: string; sourceCwd: string }> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new SessionNotFoundError("Session not found");
    const scopeId = await this.ensureDocumentScope(session);
    return {
      documentsRoot: await this.requireDocuments().prepareBtwStaging(scopeId, exchangeId),
      sourceCwd: session.cwd
    };
  }

  async inspectBtwDocumentStaging(sessionId: string, exchangeId: string): Promise<BtwDocumentChanges> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new SessionNotFoundError("Session not found");
    return this.requireDocuments().inspectBtwStaging(await this.ensureDocumentScope(session), exchangeId);
  }

  async cleanupBtwDocumentStaging(sessionId: string, exchangeId: string): Promise<void> {
    const session = await this.db.getSession(sessionId);
    if (!session) return;
    await this.requireDocuments().cleanupBtwStaging(await this.ensureDocumentScope(session), exchangeId);
  }

  async applyBtwDocumentStaging(
    sessionId: string,
    exchangeId: string
  ): Promise<{ status: "not_ready" } | (BtwDocumentApplyResult & { noticeDelivered?: boolean })> {
    const session = await this.db.getSession(sessionId);
    if (!session) throw new SessionNotFoundError("Session not found");
    if (session.archived || session.status === "missing") {
      const result = await this.requireDocuments().applyBtwStaging(await this.ensureDocumentScope(session), exchangeId);
      if (result.status === "applied") this.publishDocumentsUpdated(sessionId, result.changes);
      return { ...result, noticeDelivered: result.status === "applied" };
    }
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return { status: "not_ready" };
    if ((await this.db.listQueuedInputs(sessionId)).length > 0) return { status: "not_ready" };
    if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) return { status: "not_ready" };
    const ready = readyAppServerInputSession(session);
    if (!ready) return { status: "not_ready" };
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return { status: "not_ready" };

    this.deliveringInputSessionIds.add(sessionId);
    try {
      if ((await this.db.listQueuedInputs(sessionId)).length > 0) return { status: "not_ready" };
      if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) return { status: "not_ready" };
      const result = await this.requireDocuments().applyBtwStaging(await this.ensureDocumentScope(session), exchangeId);
      if (result.status === "conflict") return result;
      this.publishDocumentsUpdated(sessionId, result.changes);
      try {
        await this.sendSessionNotice(ready, btwDocumentNotice(exchangeId, result.changes));
        const now = nowIso();
        const status = activeInputStatus(ready.inputMode);
        await this.db.setSessionStatus(sessionId, status, now);
        this.publish("status.changed", sessionId, { status });
        return { ...result, noticeDelivered: true };
      } catch {
        return { ...result, noticeDelivered: false };
      }
    } finally {
      this.deliveringInputSessionIds.delete(sessionId);
    }
  }

  async deliverBtwDocumentNotice(sessionId: string, exchangeId: string, changes: BtwDocumentChanges): Promise<boolean> {
    const session = await this.db.getSession(sessionId);
    if (!session) return false;
    if (session.archived || session.status === "missing") return true;
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
    if ((await this.db.listQueuedInputs(sessionId)).length > 0) return false;
    if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) return false;
    const ready = readyAppServerInputSession(session);
    if (!ready) return false;
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
    this.deliveringInputSessionIds.add(sessionId);
    try {
      if ((await this.db.listQueuedInputs(sessionId)).length > 0) return false;
      if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) return false;
      await this.sendSessionNotice(ready, btwDocumentNotice(exchangeId, changes));
      const now = nowIso();
      const status = activeInputStatus(ready.inputMode);
      await this.db.setSessionStatus(sessionId, status, now);
      this.publish("status.changed", sessionId, { status });
      return true;
    } catch {
      return false;
    } finally {
      this.deliveringInputSessionIds.delete(sessionId);
    }
  }

  private publishDocumentsUpdated(sessionId: string, changes: BtwDocumentChanges): void {
    this.publish("documents.updated", sessionId, changes);
  }

  private requireDocuments(): SessionDocumentService {
    return this.documents;
  }

  private async ensureDocumentScope(session: ManagedSession): Promise<string> {
    const documents = this.requireDocuments();
    const scopeId = session.documentScopeId ?? session.gitWorkspace?.id ?? documents.newScopeId();
    await documents.ensureScope(scopeId);
    if (scopeId !== session.documentScopeId) {
      await this.db.setSessionDocumentScope(session.id, scopeId, nowIso());
    }
    return scopeId;
  }

  private async withDocumentLaunchOptions(options: AgentSessionLaunchOptions, scopeId: string): Promise<AgentSessionLaunchOptions> {
    const root = await this.requireDocuments().ensureScope(scopeId);
    const documentsRoot = join(root, "documents");
    const instruction = [
      `The only muxpilot documents directory for this session is $MUXPILOT_DOCUMENTS_DIR=${JSON.stringify(documentsRoot)}.`,
      "Resolve that environment variable before every document write; never put INDEX.md or another muxpilot document in the session cwd, repository, or another session's directory.",
      "Use $muxpilot-documents whenever durable plans, checklists, reminders, requirements, decisions, or acceptance criteria would help.",
      "Before substantive work on each turn, and after resume or context compaction, inspect the existing documents and read INDEX.md first when present.",
      "Keep relevant documents current after material progress or decisions and before asking a question or giving a final answer.",
      "As an explicit scoped exception to Plan mode's general non-mutation rule, the main agent may autonomously create, edit, rename, and delete files inside $MUXPILOT_DOCUMENTS_DIR whenever durable state is genuinely useful; this permission is not limited to particular document contents and does not require document work every turn.",
      "Do not persist the current formal <proposed_plan> before operator approval; muxpilot creates a separate indexed plan document when the operator selects Implement or Clear context and implement.",
      "Plan-mode document permission does not authorize repository changes, writes outside $MUXPILOT_DOCUMENTS_DIR, or other implementation side effects.",
      "A muxpilot BTW document notice inside <environment_context> is internal additive context, not a replacement operator request: read the named documents, reconcile them with newer user instructions, maintain INDEX.md, continue unfinished work, and do not emit a standalone acknowledgement.",
      "Document scopes are private: agent-created muxpilot child sessions keep notes in their own $MUXPILOT_DOCUMENTS_DIR and return structured proposed updates; built-in Codex subagents share this session's scope and must not edit documents; only the main parent agent verifies and updates canonical documents, and cross-session document writes are forbidden.",
      "Documents must be flat UTF-8 Markdown files with safe names, at most 100 files, 256 KiB each, and 10 MiB total; do not store secrets or raw transcripts."
    ].join(" ");
    return {
      ...options,
      writableRoots: [...new Set([...(options.writableRoots ?? []), documentsRoot])],
      environment: { ...(options.environment ?? {}), MUXPILOT_DOCUMENTS_DIR: documentsRoot },
      developerInstructions: [options.developerInstructions, instruction].filter(Boolean).join(" ")
    };
  }

  private async prepareOrchestratedLaunch(options: AgentSessionLaunchOptions): Promise<{ options: AgentSessionLaunchOptions; capabilityId: string | null }> {
    if (!this.orchestrationProvider) return { options, capabilityId: null };
    const capability = await this.orchestrationProvider.prepareLaunch();
    const instruction = "Use built-in Codex subagents for routine bounded delegation, especially standard code-review passes. Do not create a nested muxpilot session merely to perform a review in parallel; if built-in subagents are unavailable, keep the review in the current session. Use the muxpilot_sessions tools for delegated work only when the operator explicitly requests a nested muxpilot session or the work is durable and benefits from independent monitoring and its own resource scope. Agent-created muxpilot children must use fresh context. Never poll a muxpilot child: arm wait_for_sessions, then end the turn immediately. If muxpilot state appears inconsistent, compare its record with raw service, process, protocol, and Codex file evidence; report the evidence and do not attempt a workaround without operator direction. Muxpilot resolves runtime approvals according to the operator-selected per-session mode; agents cannot change that mode.";
    return {
      capabilityId: capability.capabilityId,
      options: {
        ...options,
        resourceUnitName: this.managedEnvironment.MUXPILOT_SESSION_SCOPES_AVAILABLE === "1"
          ? sessionScopeName(capability.capabilityId)
          : options.resourceUnitName,
        resourceUnitEnvironment: this.managedEnvironment.MUXPILOT_SESSION_SCOPES_AVAILABLE === "1"
          ? userSystemdLaunchEnvironment(this.managedEnvironment)
          : options.resourceUnitEnvironment,
        mcpServers: [...(options.mcpServers ?? []), capability.server],
        developerInstructions: [options.developerInstructions, instruction].filter(Boolean).join(" ")
      }
    };
  }

  private async bindOrchestratedLaunch(capabilityId: string | null, sessionId: string): Promise<ManagedSession> {
    if (!capabilityId || !this.orchestrationProvider) return requireSession(await this.db.getSession(sessionId));
    await this.orchestrationProvider.bindCapability(capabilityId, sessionId);
    await this.db.setSessionOrchestrationAvailable(sessionId, true, nowIso());
    const session = requireSession(await this.db.getSession(sessionId));
    return requireSession(await this.db.getSession(sessionId));
  }

  async sessionIdForWorkspace(workspaceId: string): Promise<string | null> {
    return (await this.gitWorkspaces?.get(workspaceId))?.sessionId ?? null;
  }

  async syncHeavyCommandSessionStatus(
    workspaceId: string,
    status: "queued" | "running" | "working" | null
  ): Promise<void> {
    const sessionId = await this.sessionIdForWorkspace(workspaceId) ??
      (await this.db.listSessions(true)).find((session) => session.gitWorkspace?.id === workspaceId)?.id ?? null;
    if (!sessionId) return;
    const session = await this.db.getSession(sessionId);
    if (status === null) {
      if (session?.status === "queued" || session?.status === "running") await this.runDiscoverTick();
      return;
    }
    if (
      !session ||
      session.archived ||
      session.initializing ||
      session.startupError ||
      HEAVY_COMMAND_STATUS_BLOCKERS.has(session.status) ||
      session.status === status
    ) return;
    const now = nowIso();
    await this.db.setSessionStatus(sessionId, status, now);
    this.publish("status.changed", sessionId, { status });
    this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
  }

  async resumeHeavyCommand(sessionId: string, message: string): Promise<boolean> {
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
    const session = await this.db.getSession(sessionId);
    if (!session || session.status === "missing") return false;
    const appServerDriver = this.appServerDriver(session);
    if (!appServerDriver || session.archived || session.initializing || session.runtime?.state !== "connected" ||
      (!isInputReadyStatus(session.status) && session.status !== "queued" && session.status !== "running" && session.status !== "working")) return false;
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
    this.deliveringInputSessionIds.add(sessionId);
    try {
      await appServerDriver.sendMessage(session, message, eventId());
      const now = nowIso();
      const status = activeInputStatus(session.inputMode);
      await this.db.setSessionStatus(sessionId, status, now);
      await this.db.addAudit("local", "resume_heavy_command", sessionId, "ok", now);
      this.publish("status.changed", sessionId, { status });
      return true;
    } finally {
      this.deliveringInputSessionIds.delete(sessionId);
    }
  }

  async discoverNow(): Promise<void> {
    await this.runDiscoverTick();
  }

  async prepareStartupRecovery(): Promise<void> {
    const previous = await this.db.getSessionRecoveryRuntime();
    const sessions = await this.db.listSessions(true);
    const preparingAt = nowIso();
    for (const session of sessions.filter(isRecoverableAppServerSession)) {
      await this.db.setSessionStatus(session.id, "unknown", preparingAt);
      await this.db.setSessionInitializing(session.id, true, preparingAt);
    }
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

  async restoreSessionRecovery(
    incidentId: string,
    sessionIds: string[]
  ): Promise<RestoreSessionRecoveryResponse> {
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

  async codexModelCatalog(): Promise<CodexModelCatalogResponse> {
    return await this.codexMetadata?.catalog() ?? {
      models: [],
      defaults: emptySessionModels()
    };
  }

  async globalModelSettings(): Promise<SessionModelSelections> {
    const [stored, catalog] = await Promise.all([
      this.db.getGlobalModelSettings(),
      this.codexModelCatalog()
    ]);
    return effectiveModelSelections(stored, catalog.defaults);
  }

  async updateGlobalModelSettings(
    mode: CollaborationMode,
    requestedModel: string,
    reasoningEffort: string | null
  ): Promise<SessionModelSelections> {
    const catalog = await this.codexModelCatalog();
    const model = requireCatalogModel(catalog, requestedModel, reasoningEffort);
    const updatedAt = nowIso();
    const settings = await this.db.setGlobalModelSettings(mode, model.model, reasoningEffort, updatedAt);
    await this.db.addAudit("local", "set_global_model_settings", "global", JSON.stringify({
      mode,
      model: model.model,
      reasoningEffort
    }), updatedAt);
    return effectiveModelSelections(settings, catalog.defaults);
  }

  async approvalReviewerSettings(): Promise<ApprovalReviewerSettings> {
    return this.db.getApprovalReviewerSettings();
  }

  async updateApprovalReviewerSettings(
    requestedModel: string,
    reasoningEffort: string | null
  ): Promise<ApprovalReviewerSettings> {
    const catalog = await this.codexModelCatalog();
    const model = requireCatalogModel(catalog, requestedModel, reasoningEffort);
    const updatedAt = nowIso();
    const settings = await this.db.setApprovalReviewerSettings({ model: model.model, reasoningEffort }, updatedAt);
    await this.db.addAudit("local", "set_approval_reviewer_settings", "global", JSON.stringify(settings), updatedAt);
    return settings;
  }

  stop(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.parserTimer) clearInterval(this.parserTimer);
    if (this.appServerHibernateTimer) clearInterval(this.appServerHibernateTimer);
    this.appServerHibernateTimer = null;
    this.codexStore.stop();
    this.approvalReviewer?.stop();
  }

  async discover(): Promise<void> {
    const codexFiles = await this.codexStore.listRecent();
    this.codexFileObservations = new Map(
      codexFiles.map((file) => [file.path, { sizeBytes: file.sizeBytes, updatedAtMs: file.updatedAtMs }])
    );
    const now = nowIso();
    await this.refreshManagedGitWorkspaces();
    for (const session of await this.db.listSessions(true)) {
      if (!session.codexSessionId) continue;
      const rollout = codexFiles.find((file) => file.sessionId === session.codexSessionId);
      if (!rollout || (session.codexJsonlPath === rollout.path && session.provider.rolloutPath === rollout.path)) continue;
      const updated = {
        ...session,
        provider: { kind: "codex" as const, threadId: session.codexSessionId, rolloutPath: rollout.path },
        codexJsonlPath: rollout.path,
        transcriptSyncing: true
      };
      await this.db.upsertSession(updated, now, true);
      this.publish("session.updated", session.id, await this.db.getSession(session.id) ?? updated);
    }
    await this.recordRecoveryRoster();
  }

  private async refreshManagedGitWorkspaces(): Promise<void> {
    if (!this.gitWorkspaces) return;
    for (const session of await this.db.listSessions(false, false)) {
      if (!session.gitWorkspace) continue;
      const stored = await this.gitWorkspaces.getBySession(session.id);
      if (!stored) continue;
      const workspace = (await this.gitWorkspaces.refresh(stored)).summary;
      if (session.repo.branch === workspace.targetBranch
        && JSON.stringify(session.gitWorkspace) === JSON.stringify(workspace)) continue;
      const updated = await this.db.setSessionGitWorkspace(session.id, workspace, nowIso());
      if (updated) this.publish("session.updated", session.id, updated);
    }
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

  private runBackgroundTask(name: "discovery" | "ingest" | "app-server recovery" | "app-server hibernation", task: () => Promise<void>): void {
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
      const offset = await this.db.getParserOffset(offsetKey);
      const result = await parseCodexJsonl(source, offset);
      if (result.contextUsage) {
        const updated = await this.db.setSessionContextUsage(session.id, result.contextUsage, nowIso());
        if (updated) {
          await this.enforceAgentWorkTokenBudget(updated);
          this.publish("session.updated", session.id, await this.db.getSession(session.id));
        }
      }
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
    const result = this.db.listSessions(true, true) as Promise<ManagedSession[]> | ManagedSession[];
    const decorate = (allSessions: ManagedSession[]) => {
      const sessions = allSessions.filter((session) =>
        (includeArchived || !session.archived) &&
        (includeMissing || session.status !== "missing" || completedAgentSessionHasVisibleAncestor(session, allSessions, includeArchived))
      );
      return sessions.map((session) => this.decorateSession(session, allSessions));
    };
    return (Array.isArray(result) ? decorate(result) : result.then(decorate)) as Promise<ManagedSession[]>;
  }

  getSession(sessionId: string): Promise<ManagedSession | null> {
    const result = this.db.getSession(sessionId) as Promise<ManagedSession | null> | ManagedSession | null;
    const decorate = (session: ManagedSession | null): Promise<ManagedSession | null> | ManagedSession | null => {
      if (!session) return null;
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

  async hasActiveHeavyCommand(sessionId: string): Promise<boolean> {
    const session = await this.db.getSession(sessionId);
    return Boolean(session?.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id));
  }

  private withResourceUsage(session: ManagedSession): ManagedSession {
    if (!this.resourceUsageLookup) return session;
    return { ...session, resourceUsage: this.resourceUsageLookup.usageForSession(session.id) };
  }

  private decorateSession(session: ManagedSession, allSessions: ManagedSession[]): ManagedSession {
    const workspace = normalizeGitWorkspaceSummary(session.gitWorkspace);
    const canonicalSession = workspace
      ? { ...session, repo: { ...session.repo, branch: workspace.targetBranch } }
      : session;
    const origin = canonicalSession.forkedFrom;
    const source = origin
      ? preferredForkSource(allSessions.filter((candidate) => candidate.codexSessionId === origin.codexSessionId))
      : null;
    const withOrigin = origin
      ? {
          ...canonicalSession,
          forkedFrom: {
            ...origin,
            sessionId: source?.id ?? null,
            sessionName: source ? sessionName(source) : origin.sessionName
          }
        }
      : canonicalSession;
    const descendants = agentDescendants(allSessions, session.id);
    const liveDescendants = descendants.filter(isLiveAgentSession);
    const worstDescendant = highestPrioritySession(liveDescendants);
    return this.withResourceUsage({
      ...withOrigin,
      status: !withOrigin.agentOwnership?.completedAt && withOrigin.agentOwnership?.budgetExhaustedAt
          ? "blocked"
          : withOrigin.status,
      agentSummary: descendants.length > 0 ? {
        liveDescendantCount: liveDescendants.length,
        totalDescendantCount: descendants.length,
        worstStatus: worstDescendant?.status ?? null,
        worstStatusSessionId: worstDescendant?.id ?? null
      } : null
    });
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

  private async restoreSessionUnlocked(
    sessionId: string,
    restoreIdentity: string
  ): Promise<{ session: ManagedSession; restored: boolean }> {
    const source = await this.db.getSession(sessionId) ??
      (await this.db.listSessions(true)).find((session) => recoveryIdentityForSession(session) === restoreIdentity) ?? null;
    if (!source) throw new SessionNotFoundError("Session not found");
    if (!source.codexSessionId) throw new SessionRestoreError("Session does not have a Codex session id to resume");

    const live = await this.findLiveSessionByRecoveryIdentity(restoreIdentity);
    if (live) {
      const session = await this.resumeAppServerSession(live);
      if (session.archived) await this.db.markSessionArchived(session.id, false, nowIso());
      const updated = requireSession(await this.db.getSession(session.id));
      this.publish("session.updated", updated.id, updated);
      return { session: updated, restored: false };
    }

    if (!this.sessionDrivers?.has()) {
      throw new SessionRestoreError("Codex app-server is unavailable; muxpilot is running in read-only history mode");
    }
    const restored = await this.resumeAppServerSession(source);
    await this.db.markSessionArchived(restored.id, false, nowIso());
    await this.db.addAudit("local", "restore_session:codex_app_server", source.id, "ok", nowIso());
    const updated = requireSession(await this.db.getSession(restored.id));
    this.publish("session.updated", updated.id, updated);
    return { session: updated, restored: true };
  }

  async importPortableSession(
    portable: PortableSession,
    transcript: Buffer,
    mapping: SessionTransferImportMapping,
    importedDocuments: SessionDocumentSnapshot[] | null = null
  ): Promise<SessionTransferImportResult> {
    this.requireAppServerDriver();
    const destination = await requireExistingDirectory(mapping.destinationCwd);
    const existing = (await this.db.listSessions(true)).find((session) => session.codexSessionId === portable.codexSessionId) ?? null;
    let selectedTranscript = transcript;
    let selectedDocuments = importedDocuments;
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
      if (selectedDocuments === null && existing.documentScopeId) {
        selectedDocuments = await this.requireDocuments().snapshot(existing.documentScopeId);
      }
      await this.db.markSessionArchived(existing.id, true, nowIso());
    }

    if (!this.codexHome) throw new SessionRestoreError("Codex home is unavailable");
    const transcriptPath = join(this.codexHome, "sessions", "imported", `rollout-imported-${portable.codexSessionId}.jsonl`);
    await atomicWrite(transcriptPath, selectedTranscript);
    const placeholderId = `imported:${eventId()}`;
    const repo = await loadRepoMetadata(destination);
    const portableName = portable.name ?? portable.sessionName;
    const documentScopeId = portable.workspaceMode === "directory" ? this.requireDocuments().newScopeId() : null;
    const session: ManagedSession = {
      id: placeholderId,
      name: portableName,
      cwd: destination,
      provider: { kind: "codex", threadId: portable.codexSessionId, rolloutPath: transcriptPath },
      repo,
      codexSessionId: portable.codexSessionId,
      codexJsonlPath: transcriptPath,
      discoveryConfidence: "high",
      status: "missing",
      lastActivityAt: portable.lastActivityAt,
      preview: "",
      recentUserPrompts: [],
      approvalMode: "ask",
      inputMode: portable.inputMode,
      models: portable.models,
      fastMode: portable.fastMode ?? null,
      fastModeAvailable: null,
      transcriptSize: 0,
      unreadCount: 0,
      pinned: portable.pinned,
      archived: false,
      forkedFrom: portable.forkedFrom ?? null,
      gitWorkspace: null,
      documentScopeId
    };
    await this.db.upsertSession(session, nowIso());

    if (portable.workspaceMode === "git") {
      if (!this.gitWorkspaces) throw new SessionRestoreError("Managed Git workspaces are unavailable");
      const targetBranch = portable.gitBranchId ? portable.targetBranch : mapping.targetBranch ?? portable.targetBranch;
      if (!targetBranch) throw new SessionRestoreError("A local target branch is required for the imported Git session");
      const workspace = await this.gitWorkspaces.provision({ sessionName: portable.sessionName, entryPath: destination, targetBranch });
      await this.gitWorkspaces.bind(workspace.id, placeholderId);
      session.gitWorkspace = workspace.summary;
      session.documentScopeId = workspace.id;
      await this.db.upsertSession(session, nowIso());
    }

    const installedScopeId = session.documentScopeId ?? this.requireDocuments().newScopeId();
    session.documentScopeId = installedScopeId;
    await this.requireDocuments().replace(installedScopeId, selectedDocuments ?? []);
    await this.db.upsertSession(session, nowIso());

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
    this.requireAppServerDriver();
    const destination = await requireExistingDirectory(mapping.destinationCwd);
    if (portable.workspaceMode !== "git") return;
    if (!this.gitWorkspaces) throw new SessionRestoreError("Managed Git workspaces are unavailable");
    const targetBranch = portable.gitBranchId ? portable.targetBranch : mapping.targetBranch ?? portable.targetBranch;
    if (!targetBranch) throw new SessionRestoreError(`A local target branch is required for '${portable.sessionName}'`);
    const probe = await this.gitWorkspaces.probe(destination);
    if (!probe.isGit || !probe.repoRoot) throw new SessionRestoreError(`Destination for '${portable.sessionName}' is not a Git repository`);
    if (!probe.localBranches.includes(targetBranch)) throw new SessionRestoreError(`Local target branch '${targetBranch}' does not exist for '${portable.sessionName}'`);
  }

  assertPortableRuntimeAvailable(_mapping: SessionTransferImportMapping): void {
    this.requireAppServerDriver();
  }

  async enqueueInput(
    sessionId: string,
    text: string,
    mode?: CollaborationMode,
    actorSessionId: string | null = null,
    content?: import("@muxpilot/core").MessageContentPart[]
  ): Promise<QueuedInput> {
    const storedSession = await this.db.getSession(sessionId);
    const session = requireSession(storedSession);
    if (session.status === "input_failed") {
      throw new QueuedInputError("Retry or dismiss the failed input before queuing another message");
    }
    const now = nowIso();
    const input: QueuedInput = {
      id: eventId(),
      sessionId,
      text,
      content,
      mode: mode ?? session.inputMode,
      status: "queued",
      error: null,
      codexSessionId: session.codexSessionId,
      codexJsonlPath: session.codexJsonlPath,
      actorSessionId,
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

  async updateQueuedInput(sessionId: string, queuedInputId: string, text: string, mode?: CollaborationMode, content?: import("@muxpilot/core").MessageContentPart[]): Promise<QueuedInput> {
    const current = await this.db.getQueuedInput(sessionId, queuedInputId);
    if (!current) throw new QueuedInputError("Queued input not found", 404);
    if (current.status === "sending") throw new QueuedInputError("Queued input is already sending");
    if (current.status === "sent") throw new QueuedInputError("Queued input has already been sent");
    const updated: QueuedInput = {
      ...current,
      text,
      content,
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
    if (session.status !== "approval") return null;
    const message = await this.db.latestApprovalMessage(sessionId);
    const approval = message ? materializeApproval(message) : null;
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
    if (session.status !== "question") return null;
    const latestQuestionMessage = await this.db.latestQuestionMessage(sessionId, true);
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
    mode?: CollaborationMode,
    actorSessionId: string | null = null,
    delivery: InputDeliveryIntent = "auto",
    content?: import("@muxpilot/core").MessageContentPart[]
  ): Promise<{ session: ManagedSession; message: ChatMessage } | { queuedInput: QueuedInput }> {
    requireSession(await this.db.getSession(sessionId));
    return this.serializeRuntimeOperation(sessionId, () => this.sendInputExclusive(sessionId, text, mode, actorSessionId, delivery, content));
  }

  private async sendInputExclusive(
    sessionId: string,
    text: string,
    mode?: CollaborationMode,
    actorSessionId: string | null = null,
    delivery: InputDeliveryIntent = "auto",
    content?: import("@muxpilot/core").MessageContentPart[]
  ): Promise<{ session: ManagedSession; message: ChatMessage } | { queuedInput: QueuedInput }> {
    let session = requireSession(await this.db.getSession(sessionId));
    if (session.runtime?.state === "hibernated") {
      session = await this.wakeAppServerSessionExclusive(session);
    }
    if (session.status === "input_failed") {
      throw new InputDeliveryError("Retry or dismiss the failed input before sending another message");
    }
    if (delivery === "steer") {
      return this.sendSteeredInputExclusive(session, text, actorSessionId, content);
    }
    if (await this.shouldQueueInput(session, text)) {
      return { queuedInput: await this.enqueueInput(sessionId, text, mode, actorSessionId, content) };
    }
    const targetMode = mode ?? session.inputMode;
    const now = nowIso();
    let message = await this.recordSubmittedInput(session, text, targetMode, now, null, actorSessionId, "turn_start", content);
    this.publish("message.appended", sessionId, message);
    message = await this.deliverSubmittedInput(session, message, targetMode);
    const latestPlanMessage = await this.db.latestPlanReadyMessage(sessionId);
    if (latestPlanMessage && isPlanActionInput(text)) {
      this.answeredPlanMessageIds.add(latestPlanMessage.id);
    }
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

  private async sendSteeredInputExclusive(
    session: ManagedSession,
    text: string,
    actorSessionId: string | null = null,
    content?: import("@muxpilot/core").MessageContentPart[]
  ): Promise<{ session: ManagedSession; message: ChatMessage } | { queuedInput: QueuedInput }> {
    const targetMode = session.inputMode;
    const driver = this.appServerDriver(session);
    const heavyweightActive = session.gitWorkspace
      ? await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id) ?? false
      : false;
    if (
      !driver
      || !session.capabilities?.steer
      || session.initializing
      || session.runtime?.kind !== "systemd_service"
      || session.runtime.state !== "connected"
      || heavyweightActive
      || !STEERABLE_SESSION_STATUSES.has(session.status)
    ) {
      return { queuedInput: await this.enqueueInput(session.id, text, targetMode, actorSessionId, content) };
    }
    if (this.deliveringInputSessionIds.has(session.id)) {
      return { queuedInput: await this.enqueueInput(session.id, text, targetMode, actorSessionId, content) };
    }

    const submittedAt = nowIso();
    let message = await this.recordSubmittedInput(
      session,
      text,
      targetMode,
      submittedAt,
      null,
      actorSessionId,
      "steer",
      content
    );
    this.publish("message.appended", session.id, message);
    this.deliveringInputSessionIds.add(session.id);
    try {
      message = await this.updateInputDelivery(message, { deliveryPhase: "delivering" });
      let receipt: DriverInputReceipt;
      let acknowledgedBy = "app_server_steer_receipt";
      try {
        receipt = await driver.steer(session, text, message.id, this.driverContent(session.id, content));
      } catch (error) {
        if (error instanceof AppServerSteerUnavailableError) {
          const queuedInput = await this.enqueueInput(session.id, text, targetMode, actorSessionId, content);
          message = await this.updateInputDelivery(message, {
            state: "pending",
            deliveryPhase: "queued",
            queuedInputId: queuedInput.id,
            failureCode: null,
            failureReason: null
          });
          await this.db.addAudit("local", "steer_input_queued", session.id, JSON.stringify({
            promptHash: inputPromptHash(session.id, text),
            promptLength: text.length,
            reason: error.message
          }), nowIso());
          this.publish("message.appended", session.id, message);
          return { queuedInput };
        }

        const reconciled = await driver.reconcileInput(session, message.id).catch(() => null);
        if (!reconciled) {
          const failureReason = inputDeliveryFailureMessage("app_server_rejected");
          message = await this.updateInputDelivery(message, {
            state: "failed",
            deliveryPhase: "failed",
            failureCode: "app_server_rejected",
            failureReason
          });
          const failedAt = nowIso();
          await this.db.setSessionStatus(session.id, "input_failed", failedAt);
          await this.db.addAudit("local", "input_delivery_failed", session.id, JSON.stringify({
            promptHash: inputPromptHash(session.id, text),
            promptLength: text.length,
            reason: "app_server_rejected",
            deliveryKind: "steer"
          }), failedAt);
          this.publish("message.appended", session.id, message);
          this.publish("status.changed", session.id, { status: "input_failed" });
          this.publish("session.updated", session.id, await this.db.getSession(session.id));
          throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
        }
        receipt = reconciled;
        acknowledgedBy = "app_server_steer_reconciliation";
      }

      message = await this.updateInputDelivery(message, {
        state: "acknowledged",
        deliveryPhase: "acknowledged",
        acknowledgedBy,
        clientMessageId: receipt.clientMessageId,
        threadId: receipt.threadId,
        turnId: receipt.turnId,
        acceptedAt: receipt.acceptedAt,
        failureReason: null
      });
      await this.db.addAudit("local", "input_delivery_app_server_steer", session.id, JSON.stringify({
        promptHash: inputPromptHash(session.id, text),
        promptLength: text.length,
        clientMessageId: receipt.clientMessageId,
        threadId: receipt.threadId,
        turnId: receipt.turnId
      }), receipt.acceptedAt);
      const updatedSession = requireSession(await this.db.getSession(session.id));
      this.publish("message.appended", session.id, message);
      this.publish("session.updated", session.id, updatedSession);
      return { session: updatedSession, message };
    } finally {
      this.deliveringInputSessionIds.delete(session.id);
    }
  }

  private async shouldQueueInput(session: ManagedSession, text: string): Promise<boolean> {
    if (this.deliveringInputSessionIds.has(session.id)) return true;
    if (session.initializing) return true;
    if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) return true;
    if (isPlanActionInput(text)) return false;
    const queuedInputs = await this.db.listQueuedInputs(session.id);
    if (queuedInputs.length > 0) return true;
    return !isInputReadyStatus(session.status);
  }

  private async sendSessionNotice(session: ManagedSession, text: string): Promise<void> {
    await this.requireAppServerDriver().sendMessage(session, text, eventId());
  }

  private async recordSubmittedInput(
    session: ManagedSession,
    text: string,
    mode: CollaborationMode,
    timestamp: string,
    queuedInputId: string | null = null,
    actorSessionId: string | null = null,
    deliveryKind: "turn_start" | "steer" = "turn_start",
    content?: import("@muxpilot/core").MessageContentPart[]
  ): Promise<ChatMessage> {
    const message: Omit<ChatMessage, "sequence"> = {
      id: eventId(),
      sessionId: session.id,
      type: "user",
      role: "user",
      timestamp,
      text,
      payload: {
        ...(content?.length ? { content } : {}),
        collaborationMode: mode,
        muxpilotSubmission: {
          codexSessionId: session.codexSessionId,
          codexJsonlPath: session.codexJsonlPath,
          state: "pending",
          deliveryPhase: "persisted",
          attemptCount: 1,
          replayCount: 0,
          lastAttemptAt: timestamp,
          promptHash: inputPromptHash(session.id, text),
          promptLength: text.length,
          queuedInputId,
          deliveryKind,
          actor: actorSessionId ? { kind: "session", sessionId: actorSessionId } : { kind: "operator" },
          failureReason: null
        }
      }
    };
    const persisted = await this.db.appendMessageWithNextSequence(message);
    if (!persisted) throw new Error("Could not persist submitted input");
    return persisted;
  }

  async agentSendInput(actorSessionId: string, targetSessionId: string, text: string, mode?: CollaborationMode): Promise<ManagedSession> {
    requireSession(await this.db.getSession(actorSessionId));
    const target = requireSession(await this.db.getSession(targetSessionId));
    if (target.archived || target.status === "missing") throw new AgentSessionError("Messages can only be sent to live sessions");
    const usage = target.contextUsage;
    const ownership = target.agentOwnership;
    const used = ownership ? agentWorkTokensUsed(ownership, usage) : 0;
    if (ownership && used >= ownership.workTokenBudget) {
      throw new AgentSessionError(`Work-token budget exhausted (${used} of ${ownership.workTokenBudget}); extend it before sending more work`);
    }
    const result = await this.sendInput(targetSessionId, text, mode, actorSessionId);
    return result && "session" in result ? result.session : target;
  }

  private async enforceAgentWorkTokenBudget(session: ManagedSession): Promise<void> {
    let ownership = session.agentOwnership;
    const usage = session.contextUsage;
    if (!ownership || !usage || ownership.completedAt) return;
    const accounted = accountAgentWorkTokens(ownership, usage);
    if (accounted !== ownership) {
      ownership = accounted;
      await this.db.setSessionAgentOwnership(session.id, ownership, nowIso());
    }
    if (ownership.budgetExhaustedAt) return;
    const used = agentWorkTokensUsed(ownership, usage);
    if (used < ownership.workTokenBudget) return;
    const exhaustedAt = nowIso();
    try {
      await this.interruptSessionRuntime(session);
    } catch (error) {
      await this.db.addAudit(
        "muxpilot",
        "agent_budget_interrupt_failed",
        session.id,
        error instanceof Error ? error.message : String(error),
        exhaustedAt
      );
      return;
    }
    await this.db.setSessionAgentOwnership(session.id, { ...ownership, budgetExhaustedAt: exhaustedAt }, exhaustedAt);
    await this.db.setSessionStatus(session.id, "blocked", exhaustedAt);
    await this.db.addAudit("muxpilot", "agent_budget_exhausted", session.id, `${used}:${ownership.workTokenBudget}`, exhaustedAt);
    this.publish("status.changed", session.id, { status: "blocked" });
  }

  async agentCreateChild(actorSessionId: string, name: string, task: string, mode?: CollaborationMode): Promise<ManagedSession> {
    return this.withAgentMutation(async () => {
      const actor = requireSession(await this.db.getSession(actorSessionId));
      if (this.managedEnvironment.MUXPILOT_SESSION_SCOPES_AVAILABLE !== "1") {
        throw new AgentSessionError(AGENT_SCOPE_UNAVAILABLE_MESSAGE);
      }
      const all = await this.db.listSessions(true);
      const rootSessionId = actor.agentOwnership?.rootSessionId ?? actor.id;
      if (liveAgentDescendants(all, rootSessionId).length >= AGENT_DESCENDANT_LIMIT) {
        throw new AgentSessionError(`This root already has ${AGENT_DESCENDANT_LIMIT} live agent-managed sessions`);
      }
      const cwd = actor.gitWorkspace?.entryPath ?? actor.repo.root ?? actor.cwd;
      const request: CreateSessionRequest = actor.gitWorkspace
        ? { cwd, name, workspace: { mode: "git", targetBranch: actor.gitWorkspace.targetBranch } }
        : { cwd, name, workspace: { mode: "directory" } };
      const childMode = mode ?? "default";
      const inheritedSettings = { ...actor.models[childMode], fastMode: actor.fastMode };
      const child = await this.createSession(request, inheritedSettings);
      const ownership: AgentSessionOwnership = {
        parentSessionId: actor.id,
        rootSessionId,
        origin: "created",
        createdAt: nowIso(),
        workTokenBaseline: child.contextUsage?.lifetimeWorkTokens ?? 0,
        workTokensUsed: 0,
        workTokenLastObserved: child.contextUsage?.lifetimeWorkTokens,
        workTokenLastSampledAt: child.contextUsage?.sampledAt ?? null,
        workTokenBudget: DEFAULT_AGENT_WORK_TOKEN_BUDGET,
        completedAt: null,
        budgetExhaustedAt: null
      };
      await this.db.setSessionAgentOwnership(child.id, ownership, nowIso());
      for (const selection of ["default", "plan"] as const) {
        const settings = actor.models[selection];
        if (settings.model) await this.db.setSessionModelSettings(child.id, selection, settings.model, settings.reasoningEffort, nowIso());
      }
      await this.waitForAgentChildReady(child.id);
      await this.sendInput(child.id, task, childMode, actor.id);
      const updated = requireSession(await this.db.getSession(child.id));
      this.publish("session.updated", child.id, updated);
      return updated;
    });
  }

  async agentClaim(actorSessionId: string, childSessionId: string): Promise<ManagedSession> {
    return this.withAgentMutation(async () => {
      const actor = requireSession(await this.db.getSession(actorSessionId));
      if (this.managedEnvironment.MUXPILOT_SESSION_SCOPES_AVAILABLE !== "1") {
        throw new AgentSessionError(AGENT_SCOPE_UNAVAILABLE_MESSAGE);
      }
      const child = requireSession(await this.db.getSession(childSessionId));
      if (child.id === actor.id) throw new AgentSessionError("A session cannot claim itself");
      if (child.agentOwnership) throw new AgentSessionError("Session already has an agent manager");
      if (child.status === "missing" || child.archived) throw new AgentSessionError("Only live sessions can be claimed");
      const all = await this.db.listSessions(true);
      const claimedSubtree = [child, ...agentDescendants(all, child.id)];
      if (claimedSubtree.some((session) => isLiveManagedSession(session) && !isMuxpilotSessionResourceUnit(session.resourceUnit ?? session.resourceScope))) {
        throw new AgentSessionError("Only sessions running in dedicated muxpilot resource units can be claimed. Restore this session after enabling user systemd, then retry.");
      }
      if (claimedSubtree.some((session) => session.id === actor.id)) {
        throw new AgentSessionError("Claiming this session would create an agent-session cycle");
      }
      const rootSessionId = actor.agentOwnership?.rootSessionId ?? actor.id;
      const addedLiveCount = claimedSubtree.filter(isLiveManagedSession).length;
      if (liveAgentDescendants(all, rootSessionId).length + addedLiveCount > AGENT_DESCENDANT_LIMIT) {
        throw new AgentSessionError("Agent-managed session limit reached");
      }
      const ownership: AgentSessionOwnership = {
        parentSessionId: actor.id,
        rootSessionId,
        origin: "claimed",
        createdAt: nowIso(),
        workTokenBaseline: child.contextUsage?.lifetimeWorkTokens ?? 0,
        workTokensUsed: 0,
        workTokenLastObserved: child.contextUsage?.lifetimeWorkTokens,
        workTokenLastSampledAt: child.contextUsage?.sampledAt ?? null,
        workTokenBudget: DEFAULT_AGENT_WORK_TOKEN_BUDGET,
        completedAt: null,
        budgetExhaustedAt: null
      };
      const updated = requireSession(await this.db.setSessionAgentOwnership(child.id, ownership, nowIso()));
      for (const descendant of claimedSubtree.slice(1)) {
        if (!descendant.agentOwnership) continue;
        await this.db.setSessionAgentOwnership(descendant.id, { ...descendant.agentOwnership, rootSessionId }, nowIso());
      }
      await this.db.addAudit(`session:${actor.id}`, "claim_session", child.id, "ok", nowIso());
      this.publish("session.updated", child.id, updated);
      return updated;
    });
  }

  async agentRelease(actorSessionId: string, childSessionId: string): Promise<ManagedSession> {
    return this.withAgentMutation(async () => {
      const child = await this.requireAgentControl(actorSessionId, childSessionId);
      const descendants = agentDescendants(await this.db.listSessions(true), child.id);
      if (descendants.some(isLiveAgentSession)) {
        throw new AgentSessionError("Release live descendants before releasing their parent session");
      }
      const updated = requireSession(await this.db.setSessionAgentOwnership(child.id, null, nowIso()));
      for (const descendant of descendants) {
        if (!descendant.agentOwnership) continue;
        await this.db.setSessionAgentOwnership(descendant.id, {
          ...descendant.agentOwnership,
          rootSessionId: child.id
        }, nowIso());
      }
      await this.db.addAudit(`session:${actorSessionId}`, "release_session", child.id, "ok", nowIso());
      this.publish("session.updated", child.id, updated);
      return updated;
    });
  }

  async operatorSetAgentParent(childSessionId: string, parentSessionId: string | null): Promise<ManagedSession> {
    return this.withAgentMutation(async () => {
      const child = requireSession(await this.db.getSession(childSessionId));
      const all = await this.db.listSessions(true);
      const subtreeIds = new Set([child.id, ...agentDescendants(all, child.id).map((session) => session.id)]);
      if (parentSessionId === null) {
        const updated = requireSession(await this.db.setSessionAgentOwnership(child.id, null, nowIso()));
        for (const descendant of all.filter((session) => subtreeIds.has(session.id) && session.id !== child.id)) {
          if (!descendant.agentOwnership) continue;
          await this.db.setSessionAgentOwnership(descendant.id, {
            ...descendant.agentOwnership,
            rootSessionId: child.id
          }, nowIso());
        }
        await this.db.addAudit("local", "detach_agent_session", child.id, "ok", nowIso());
        this.publish("session.updated", child.id, updated);
        return updated;
      }

      if (this.managedEnvironment.MUXPILOT_SESSION_SCOPES_AVAILABLE !== "1") {
        throw new AgentSessionError(AGENT_SCOPE_UNAVAILABLE_MESSAGE);
      }
      if (all.some((session) => subtreeIds.has(session.id) && isLiveManagedSession(session) && !isMuxpilotSessionResourceUnit(session.resourceUnit ?? session.resourceScope))) {
        throw new AgentSessionError("Only sessions running in dedicated muxpilot resource units can be attached. Restore this session after enabling user systemd, then retry.");
      }

      const parent = requireSession(await this.db.getSession(parentSessionId));
      if (child.status === "missing" || child.archived) throw new AgentSessionError("Only live sessions can be attached");
      if (subtreeIds.has(parent.id)) throw new AgentSessionError("An agent-session hierarchy cannot contain a cycle");
      if (parent.status === "missing" || parent.archived) throw new AgentSessionError("The new parent must be a live session");
      const rootSessionId = parent.agentOwnership?.rootSessionId ?? parent.id;
      const existingTreeIds = new Set([rootSessionId, ...agentDescendants(all, rootSessionId).map((session) => session.id)]);
      const addedLiveCount = all.filter((session) => subtreeIds.has(session.id) && isLiveManagedSession(session) && !existingTreeIds.has(session.id)).length;
      if (liveAgentDescendants(all, rootSessionId).length + addedLiveCount > AGENT_DESCENDANT_LIMIT) {
        throw new AgentSessionError(`This root cannot exceed ${AGENT_DESCENDANT_LIMIT} live agent-managed sessions`);
      }
      const ownership: AgentSessionOwnership = {
        parentSessionId: parent.id,
        rootSessionId,
        origin: child.agentOwnership?.origin ?? "claimed",
        createdAt: child.agentOwnership?.createdAt ?? nowIso(),
        workTokenBaseline: child.agentOwnership?.workTokenBaseline ?? child.contextUsage?.lifetimeWorkTokens ?? 0,
        workTokensUsed: child.agentOwnership?.workTokensUsed,
        workTokenLastObserved: child.agentOwnership?.workTokenLastObserved,
        workTokenLastSampledAt: child.agentOwnership?.workTokenLastSampledAt ?? null,
        workTokenBudget: child.agentOwnership?.workTokenBudget ?? DEFAULT_AGENT_WORK_TOKEN_BUDGET,
        completedAt: child.agentOwnership?.completedAt ?? null,
        budgetExhaustedAt: child.agentOwnership?.budgetExhaustedAt ?? null
      };
      const updated = requireSession(await this.db.setSessionAgentOwnership(child.id, ownership, nowIso()));
      for (const descendant of all.filter((session) => subtreeIds.has(session.id) && session.id !== child.id)) {
        if (!descendant.agentOwnership) continue;
        await this.db.setSessionAgentOwnership(descendant.id, {
          ...descendant.agentOwnership,
          rootSessionId
        }, nowIso());
      }
      await this.db.addAudit("local", "reparent_agent_session", child.id, parent.id, nowIso());
      this.publish("session.updated", child.id, updated);
      return updated;
    });
  }

  async agentExtendBudget(actorSessionId: string, childSessionId: string, additionalTokens: number, reason: string): Promise<ManagedSession> {
    return this.withAgentMutation(async () => {
      const child = await this.requireAgentControl(actorSessionId, childSessionId);
      return this.extendAgentBudget(child, additionalTokens, reason, `session:${actorSessionId}`, false);
    });
  }

  async operatorExtendAgentBudget(sessionId: string, additionalTokens: number, reason: string): Promise<ManagedSession> {
    return this.withAgentMutation(async () => {
      const child = requireLiveAgentSession(await this.db.getSession(sessionId));
      if (!child.agentOwnership?.budgetExhaustedAt) throw new AgentSessionError("This session has not exhausted its work-token budget");
      return this.extendAgentBudget(child, additionalTokens, reason, "local", true);
    });
  }

  private async extendAgentBudget(
    child: ManagedSession,
    additionalTokens: number,
    reason: string,
    actor: string,
    requireExhausted: boolean
  ): Promise<ManagedSession> {
    const ownership = child.agentOwnership;
    if (!ownership || ownership.completedAt || child.archived || child.status === "missing") {
      throw new AgentSessionError("Budget extensions require a live agent-managed session");
    }
    if (requireExhausted && !ownership.budgetExhaustedAt) throw new AgentSessionError("This session has not exhausted its work-token budget");
    if (!Number.isSafeInteger(additionalTokens) || additionalTokens < 1 || additionalTokens > 2_000_000) {
      throw new AgentSessionError("Budget extension must be between 1 and 2,000,000 work tokens");
    }
    const normalizedReason = requireAgentGuardReason(reason);
    const now = nowIso();
    let updated = requireSession(await this.db.setSessionAgentOwnership(child.id, {
      ...ownership,
      workTokenBudget: ownership.workTokenBudget + additionalTokens,
      budgetExhaustedAt: null
    }, now));
    updated = await this.restoreAgentGuardStatus(updated, now);
    await this.db.addAudit(actor, "extend_agent_budget", child.id, `${additionalTokens}:${normalizedReason}`, now);
    this.publish("session.updated", child.id, updated);
    return updated;
  }

  private async restoreAgentGuardStatus(session: ManagedSession, updatedAt: string): Promise<ManagedSession> {
    const ownership = session.agentOwnership;
    const nextStatus = ownership?.budgetExhaustedAt
      ? "blocked"
      : session.status === "blocked" ? "waiting" : session.status;
    if (nextStatus === session.status) return session;
    await this.db.setSessionStatus(session.id, nextStatus, updatedAt);
    return requireSession(await this.db.getSession(session.id));
  }

  async requireAgentControl(actorSessionId: string, targetSessionId: string): Promise<ManagedSession> {
    return requireSession(await this.requireAgentControlRecord(actorSessionId, targetSessionId));
  }

  private async requireAgentControlRecord(actorSessionId: string, targetSessionId: string): Promise<ManagedSession> {
    const target = await this.db.getSession(targetSessionId);
    if (!target) throw new AgentSessionError("Session not found");
    const all = await this.db.listSessions(true);
    let current = target;
    const seen = new Set<string>();
    while (current.agentOwnership && !seen.has(current.id)) {
      if (current.agentOwnership.parentSessionId === actorSessionId) return target;
      seen.add(current.id);
      const parent = all.find((session) => session.id === current.agentOwnership?.parentSessionId);
      if (!parent) break;
      current = parent;
    }
    throw new AgentSessionError("This action is limited to descendants managed by the calling session");
  }

  async agentFinish(actorSessionId: string, targetSessionId: string): Promise<void> {
    await this.withAgentMutation(async () => {
      const target = await this.requireAgentControlRecord(actorSessionId, targetSessionId);
      if (target.agentOwnership?.completedAt) return;
      const descendants = agentDescendants(await this.db.listSessions(true), target.id).reverse();
      for (const session of [...descendants, target]) {
        const current = await this.db.getSession(session.id);
        if (!current?.agentOwnership || current.agentOwnership.completedAt) continue;
        if (current.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(current.gitWorkspace.id, "owning agent session was finished");
        if (current.runtime && current.runtime.state !== "hibernated" && current.runtime.state !== "stopped") {
          await this.requireAppServerDriver().kill(current);
          await this.db.upsertSession({ ...current, runtime: { ...current.runtime, state: "stopped" } }, nowIso());
        }
        const completedAt = nowIso();
        const completed = await this.db.completeAgentSession(current.id, completedAt);
        await this.db.addAudit(`session:${actorSessionId}`, "finish_agent_session", current.id, "ok", completedAt);
        if (completed) this.publish("session.updated", current.id, completed);
      }
    });
  }

  async resumeAgentWait(sessionId: string, message: string): Promise<boolean> {
    const storedSession = await this.db.getSession(sessionId);
    if (!storedSession || storedSession.status === "missing") return false;
    return this.serializeRuntimeOperation(sessionId, async () => {
      if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
      const session = await this.db.getSession(sessionId);
      if (!session || session.archived || !readyAppServerInputSession(session)) return false;
      if ((await this.db.listQueuedInputs(sessionId)).length > 0) return false;
      if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) return false;

      const driver = this.appServerDriver(session);
      if (!driver) return false;
      this.deliveringInputSessionIds.add(sessionId);
      try {
        await driver.sendMessage(session, message, eventId());
        const now = nowIso();
        const status = activeInputStatus(session.inputMode);
        await this.db.setSessionStatus(sessionId, status, now);
        await this.db.addAudit("muxpilot", "resume_agent_wait", sessionId, "ok", now);
        this.publish("status.changed", sessionId, { status });
        return true;
      } catch (error) {
        await this.db.addAudit("muxpilot", "resume_agent_wait", sessionId, error instanceof Error ? error.message : String(error), nowIso());
        return false;
      } finally {
        this.deliveringInputSessionIds.delete(sessionId);
      }
    });
  }

  private withAgentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.agentMutationQueue.catch(() => undefined).then(operation);
    this.agentMutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async interruptSessionRuntime(session: ManagedSession): Promise<void> {
    await this.requireAppServerDriver().interrupt(session, null);
  }

  private async waitForAgentChildReady(sessionId: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const session = await this.db.getSession(sessionId);
      if (!session) throw new AgentSessionError("Created child session disappeared during startup");
      if (session.startupError) throw new AgentSessionError(session.startupError);
      if (!session.initializing) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new AgentSessionError("Created child session did not become ready within 60 seconds");
  }

  private async deliverSubmittedInput(
    session: ManagedSession,
    message: ChatMessage,
    mode: CollaborationMode
  ): Promise<ChatMessage> {
    if (this.deliveringInputSessionIds.has(session.id)) throw new InputDeliveryError("Another input delivery is already in progress for this session");
    this.deliveringInputSessionIds.add(session.id);
    let current = message;
    try {
      current = await this.updateInputDelivery(current, { deliveryPhase: "delivering" });
      const driver = this.requireAppServerDriver();
      if (session.inputMode !== mode) {
        await driver.setPreferences(session, { mode });
        await this.db.setSessionInputMode(session.id, mode, nowIso());
      }
      const content = Array.isArray(message.payload.content) ? message.payload.content as import("@muxpilot/core").MessageContentPart[] : undefined;
      const receipt = await driver.sendMessage({ ...session, inputMode: mode }, message.text, message.id, this.driverContent(session.id, content));
      const latest = await this.db.latestUserMessage(session.id);
      if (latest?.id === current.id) current = latest;
      current = await this.updateInputDelivery(current, {
        state: "acknowledged", deliveryPhase: "acknowledged", acknowledgedBy: "app_server_receipt",
        clientMessageId: receipt.clientMessageId, threadId: receipt.threadId, turnId: receipt.turnId,
        acceptedAt: receipt.acceptedAt, failureReason: null
      });
      await this.db.addAudit("local", "input_delivery_app_server", session.id, JSON.stringify({
        promptHash: inputPromptHash(session.id, message.text), promptLength: message.text.length,
        clientMessageId: receipt.clientMessageId, threadId: receipt.threadId, turnId: receipt.turnId
      }), receipt.acceptedAt);
      return current;
    } catch (error) {
      const reason: InputDeliveryFailureCode = "app_server_rejected";
      current = await this.updateInputDelivery(current, {
        state: "failed", deliveryPhase: "failed", failureCode: reason,
        failureReason: inputDeliveryFailureMessage(reason)
      });
      const failedAt = nowIso();
      await this.db.setSessionStatus(session.id, "input_failed", failedAt);
      await this.db.addAudit("local", "input_delivery_failed", session.id, JSON.stringify({
        promptHash: inputPromptHash(session.id, message.text), promptLength: message.text.length, reason
      }), failedAt);
      this.publish("message.appended", session.id, current);
      this.publish("status.changed", session.id, { status: "input_failed" });
      this.publish("session.updated", session.id, await this.db.getSession(session.id));
      throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
    } finally {
      this.deliveringInputSessionIds.delete(session.id);
    }
  }

  private driverContent(sessionId: string, content?: import("@muxpilot/core").MessageContentPart[]): import("@muxpilot/core").MessageContentPart[] | undefined {
    if (!content?.length) return undefined;
    const imagePath = this.imagePath;
    if (!imagePath) throw new InputDeliveryError("Image delivery is unavailable");
    return content.map((part) => part.type === "image" ? { ...part, id: imagePath(sessionId, part.id) } : part);
  }

  async resolveApproval(
    sessionId: string,
    request: ResolveApprovalRequest,
    automation: Pick<TranscriptInteractionOutcome, "resolvedBy" | "reviewerModel" | "reviewerExplanation"> = { resolvedBy: "user" }
  ): Promise<void> {
    const session = requireSession(await this.db.getSession(sessionId));
    const approval = await this.getPendingApproval(sessionId);
    if (!approval) throw new ApprovalResolutionError("No pending approval for this session");
    const expectedMessageId = (request as ResolveApprovalRequest & { messageId?: string }).messageId;
    if (expectedMessageId && expectedMessageId !== approval.messageId) throw new ApprovalResolutionError("The approval request changed before this decision was submitted");
    if (!approval.options.some((option) => option.decision === request.decision)) throw new ApprovalResolutionError("This choice is not available for the pending approval");
    if (request.decision === "approve_for_prefix" && !approval.prefixRule?.length) throw new ApprovalResolutionError("This approval request does not include a persistent prefix rule");
    const workspace = await this.db.getGitWorkspaceBySession(sessionId);
    const decision = request.decision === "approve_for_prefix" && workspace ? "approve_once" : request.decision;
    try {
      await this.requireAppServerDriver().answerApproval(session, approval.requestId ?? approval.id, decision);
    } catch (error) {
      throw new ApprovalResolutionError("Could not submit the approval to Codex app-server: " + (error instanceof Error ? error.message : String(error)));
    }
    const now = nowIso();
    await this.recordInteractionOutcome(approval.messageId, sessionId, {
      kind: "approval", status: "answered", decision: request.decision, submittedAt: now, ...automation
    });
    if (request.decision === "approve_for_prefix" && approval.prefixRule?.length && workspace) {
      await this.db.addRepositoryApprovalRule(workspace.commonGitDir, normalizeRepositoryApprovalPrefix(approval.prefixRule, workspace), now);
    }
    await this.db.setSessionStatus(sessionId, "waiting", now);
    await this.db.addAudit("local", "approval:" + request.decision, sessionId, "ok", now);
    this.publish("status.changed", sessionId, { status: "waiting" });
    this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
  }

  async handleAutomatedApproval(sessionId: string, messageId: string): Promise<void> {
    const session = await this.db.getSession(sessionId);
    if (!session || session.approvalMode === "ask" || this.automatedApprovalMessageIds.has(messageId)) return;
    const approval = await this.getPendingApproval(sessionId);
    if (!approval || approval.messageId !== messageId) return;
    this.automatedApprovalMessageIds.add(messageId);
    try {
      if (session.approvalMode === "full") {
        const current = await this.db.getSession(sessionId);
        const pending = await this.getPendingApproval(sessionId);
        if (!current || current.approvalMode !== "full" || pending?.messageId !== messageId) return;
        await this.resolveApproval(sessionId, { decision: "approve_once", messageId }, { resolvedBy: "full" });
        return;
      }
      if (!this.approvalReviewer) return;
      const settings = await this.db.getApprovalReviewerSettings();
      await this.recordApprovalReview(sessionId, messageId, "reviewing", settings.model);
      let review: ApprovalReviewResult;
      try {
        review = await this.approvalReviewer.review(session, approval, settings);
      } catch (error) {
        const explanation = error instanceof Error ? error.message : String(error);
        await this.recordApprovalReview(sessionId, messageId, "escalated", settings.model, explanation);
        await this.db.addAudit("local", "approval_review_escalated", sessionId, JSON.stringify({
          messageId,
          model: settings.model,
          reason: explanation
        }), nowIso());
        return;
      }
      if (review.decision === "escalate") {
        await this.recordApprovalReview(sessionId, messageId, "escalated", settings.model, review.explanation);
        await this.db.addAudit("local", "approval_review_escalated", sessionId, JSON.stringify({
          messageId, model: settings.model, explanation: review.explanation
        }), nowIso());
        return;
      }
      const current = await this.db.getSession(sessionId);
      const pending = await this.getPendingApproval(sessionId);
      if (!current || current.approvalMode !== "auto" || pending?.messageId !== messageId) return;
      await this.resolveApproval(
        sessionId,
        { decision: review.decision === "approve" ? "approve_once" : "deny", messageId },
        { resolvedBy: "auto", reviewerModel: settings.model, reviewerExplanation: review.explanation }
      );
    } catch (error) {
      await this.db.addAudit("local", "automated_approval_failed", sessionId, error instanceof Error ? error.message : String(error), nowIso());
    } finally {
      this.automatedApprovalMessageIds.delete(messageId);
    }
  }

  async recoverAutomatedApprovals(): Promise<void> {
    for (const session of await this.db.listSessions(true)) {
      if (session.status !== "approval" || session.approvalMode === "ask") continue;
      const approval = await this.getPendingApproval(session.id);
      if (approval) void this.handleAutomatedApproval(session.id, approval.messageId);
    }
  }

  private async recordApprovalReview(
    sessionId: string,
    messageId: string,
    reviewStatus: "reviewing" | "escalated",
    reviewerModel: string,
    reviewerExplanation?: string
  ): Promise<void> {
    const message = await this.db.getMessage(sessionId, messageId);
    const approval = message ? recordValue(message.payload.approval) : null;
    if (!message || !approval) return;
    const updated = await this.db.updateMessagePayload(message, {
      ...message.payload,
      approval: { ...approval, reviewStatus, reviewerModel, reviewerExplanation }
    });
    if (updated) this.publish("message.appended", sessionId, updated);
  }

  async answerQuestion(sessionId: string, request: QuestionAnswerRequest): Promise<void> {
    const session = requireSession(await this.db.getSession(sessionId));
    const question = await this.getPendingQuestion(sessionId);
    if (!question) throw new QuestionResolutionError("No pending question for this session");
    const expectedMessageId = (request as QuestionAnswerRequest & { messageId?: string }).messageId;
    if (expectedMessageId && expectedMessageId !== question.messageId) throw new QuestionResolutionError("The question changed before this answer was submitted");
    const normalized = normalizeQuestionAnswer(question, request);
    try {
      await this.requireAppServerDriver().answerQuestion(session, question.requestId ?? question.id, normalized);
    } catch (error) {
      if (error instanceof QuestionResolutionError) throw error;
      throw new QuestionResolutionError(`Could not submit the answer to Codex app-server: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.answeredQuestionMessageIds.add(question.messageId);
    const now = nowIso();
    await this.recordInteractionOutcome(question.messageId, sessionId, {
      kind: "question", status: "answered", answers: normalized.answers, submittedAt: now
    });
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
      const candidate = session.gitWorkspace?.entryPath ?? session.repo.root ?? session.cwd;
      const next = await directorySuggestionFromPath(candidate, "active", session.lastActivityAt, {
        label: session.repo.name,
        repoRoot: session.repo.root,
        branch: normalizeGitWorkspaceSummary(session.gitWorkspace)?.targetBranch ?? session.repo.branch
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

  async createSessionInDirectory(
    cwd: string,
    name: string,
    launchSettings?: { model: string | null; reasoningEffort: string | null; fastMode?: boolean | null }
  ): Promise<ManagedSession> {
    const directory = await requireExistingDirectory(cwd);
    const sessionName = requireSessionName(name);
    this.requireAppServerDriver();
    const preferences = launchSettings === undefined
      ? await this.defaultAppServerPreferences()
      : undefined;
    const resolvedLaunchSettings = launchSettings ?? (preferences ? {
      ...preferences.models.default,
      fastMode: preferences.fastMode
    } : undefined);
    const documentScopeId = this.requireDocuments().newScopeId();
    const documentOptions = await this.withDocumentLaunchOptions({
      environment: this.managedEnvironment,
      ...resolvedLaunchSettings
    }, documentScopeId);
    const prepared = await this.prepareOrchestratedLaunch(documentOptions);
    const session = await this.launchAppServerSession({
      operation: "start",
      directory,
      repoPath: directory,
      sessionName,
      options: prepared.options,
      orchestrationCapabilityId: prepared.capabilityId,
      preferences,
      documentScopeId
    });
    await this.db.addAudit("local", "create_session", session.id, "codex_app_server", nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  async createSession(
    request: CreateSessionRequest,
    launchSettings?: { model: string | null; reasoningEffort: string | null; fastMode?: boolean | null }
  ): Promise<ManagedSession> {
    const directory = await requireExistingDirectory(request.cwd);
    const sessionName = requireSessionName(request.name);
    this.requireAppServerDriver();
    const probe = await this.gitWorkspaces?.probe(directory) ?? null;
    if (probe?.isGit && request.workspace?.mode !== "git") {
      throw new CreateSessionError("Target branch is required for new Git sessions", 400);
    }
    if (request.workspace?.mode !== "git") {
      return this.createSessionInDirectory(directory, sessionName, launchSettings);
    }
    if (!this.gitWorkspaces) throw new CreateSessionError("Managed Git workspaces are unavailable", 503);

    const workspace = await this.gitWorkspaces.provision({
      sessionName,
      entryPath: directory,
      targetBranch: request.workspace.targetBranch
    });
    const controlPath = await this.gitWorkspaces.ensureControlPath(workspace);
    const preferences = launchSettings === undefined
      ? await this.defaultAppServerPreferences()
      : undefined;
    const resolvedLaunchSettings = launchSettings ?? (preferences ? {
      ...preferences.models.default,
      fastMode: preferences.fastMode
    } : undefined);
    const documentOptions = await this.withDocumentLaunchOptions({
      ...managedCodexLaunchOptions(workspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment),
      model: resolvedLaunchSettings?.model,
      reasoningEffort: resolvedLaunchSettings?.reasoningEffort,
      fastMode: resolvedLaunchSettings?.fastMode
    }, workspace.id);
    const prepared = await this.prepareOrchestratedLaunch(documentOptions);
    const session = await this.launchAppServerSession({
      operation: "start",
      directory: controlPath,
      repoPath: workspace.summary.entryPath,
      sessionName,
      options: prepared.options,
      orchestrationCapabilityId: prepared.capabilityId,
      gitWorkspace: workspace.summary,
      gitWorkspaceId: workspace.id,
      preferences,
      documentScopeId: workspace.id
    });
    await this.db.addAudit("local", "create_git_session", session.id, workspace.id, nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  async forkSession(sessionId: string, name: string): Promise<ManagedSession> {
    const source = await this.db.getSession(sessionId);
    if (!source) throw new SessionNotFoundError("Session not found");
    const sourceThreadId = source.provider?.threadId ?? source.codexSessionId;
    if (!sourceThreadId) throw new CreateSessionError("Session does not have a Codex session id to fork");
    const sessionNameValue = requireSessionName(name);
    const forkedFrom: SessionForkOrigin = {
      codexSessionId: sourceThreadId,
      sessionId: source.id,
      sessionName: sessionName(source)
    };
    this.requireAppServerDriver();
    return this.forkAppServerSession(source, sourceThreadId, sessionNameValue, forkedFrom);
  }

  private async forkAppServerSession(
    source: ManagedSession,
    sourceThreadId: string,
    sessionNameValue: string,
    forkedFrom: SessionForkOrigin
  ): Promise<ManagedSession> {
    let gitWorkspace: GitWorkspaceSummary | null = null;
    let documentScopeId: string;
    let directory: string;
    let repoPath: string;
    let documentOptions: AgentSessionLaunchOptions;
    const activeModel = source.models[source.inputMode];
    const inheritedSettings = {
      model: activeModel.model,
      reasoningEffort: activeModel.reasoningEffort,
      fastMode: source.fastMode
    };
    let workspaceId: string | null = null;

    if (source.gitWorkspace) {
      if (!this.gitWorkspaces) throw new CreateSessionError("Managed Git workspaces are unavailable", 503);
      const workspace = await this.gitWorkspaces.provision({
        sessionName: sessionNameValue,
        entryPath: source.gitWorkspace.entryPath,
        targetBranch: source.gitWorkspace.targetBranch
      });
      directory = await this.gitWorkspaces.ensureControlPath(workspace);
      repoPath = workspace.summary.entryPath;
      gitWorkspace = workspace.summary;
      workspaceId = workspace.id;
      documentScopeId = workspace.id;
      await this.requireDocuments().copy(await this.ensureDocumentScope(source), documentScopeId);
      documentOptions = await this.withDocumentLaunchOptions({
        ...managedCodexLaunchOptions(workspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment),
        ...inheritedSettings
      }, documentScopeId);
    } else {
      repoPath = await requireExistingDirectory(source.cwd ?? source.repo.root);
      directory = repoPath;
      documentScopeId = this.requireDocuments().newScopeId();
      await this.requireDocuments().copy(await this.ensureDocumentScope(source), documentScopeId);
      documentOptions = await this.withDocumentLaunchOptions({
        environment: this.managedEnvironment,
        ...inheritedSettings
      }, documentScopeId);
    }

    const prepared = await this.prepareOrchestratedLaunch(documentOptions);
    const session = await this.launchAppServerSession({
      operation: "fork",
      directory,
      repoPath,
      sessionName: sessionNameValue,
      options: prepared.options,
      sourceThreadId,
      orchestrationCapabilityId: prepared.capabilityId,
      gitWorkspace,
      gitWorkspaceId: workspaceId,
      forkedFrom,
      preferences: source,
      documentScopeId
    });
    await this.db.addAudit("local", "fork_session", session.id, source.id, nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  private async launchAppServerSession(input: {
    operation: "start" | "resume" | "fork";
    directory: string;
    repoPath: string;
    sessionName: string;
    options: AgentSessionLaunchOptions;
    sourceThreadId?: string;
    orchestrationCapabilityId: string | null;
    gitWorkspace?: GitWorkspaceSummary | null;
    gitWorkspaceId?: string | null;
    forkedFrom?: SessionForkOrigin | null;
    preferences?: Pick<ManagedSession, "inputMode" | "models" | "fastMode" | "fastModeAvailable">;
    documentScopeId: string;
  }): Promise<ManagedSession> {
    const driver = this.requireAppServerDriver();
    const sessionId = `app-${eventId()}`;
    const launch = await driver[input.operation]({
      sessionId,
      name: input.sessionName,
      cwd: input.directory,
      options: input.options,
      sourceThreadId: input.sourceThreadId
    });
    if (launch.sessionId !== sessionId) {
      await driver.kill(appServerLaunchSession(launch, input.sessionName, input.directory)).catch(() => undefined);
      throw new Error(`App-server driver returned the wrong session id: expected ${sessionId}, received ${launch.sessionId}`);
    }
    let session: ManagedSession | null = null;
    try {
      session = await this.persistInitializingAppServerSession(
        launch,
        input.sessionName,
        input.directory,
        input.repoPath,
        input.gitWorkspace ?? null,
        input.forkedFrom ?? null,
        input.preferences,
        input.documentScopeId
      );
      if (input.gitWorkspaceId) {
        if (!this.gitWorkspaces) throw new Error("Managed Git workspaces disappeared during app-server launch");
        await this.gitWorkspaces.bind(input.gitWorkspaceId, session.id);
      }
      session = await this.bindOrchestratedLaunch(input.orchestrationCapabilityId, session.id);
      this.finishSessionInitialization(session.id, launch.ready);
      return session;
    } catch (error) {
      await driver.kill(session ?? appServerLaunchSession(launch, input.sessionName, input.directory)).catch(() => undefined);
      if (session) {
        const startupError = error instanceof Error ? error.message : "App-server session initialization failed";
        try {
          await this.db.setSessionInitializationResult(session.id, "startup_failed", startupError, nowIso());
        } catch {
          // Preserve the original launch/binding failure after best-effort failure-state persistence.
        }
      }
      throw error;
    }
  }

  private async appServerHibernationBlockers(session: ManagedSession): Promise<string[]> {
    if (!session.runtime) {
      return ["unsupported_runtime"];
    }
    const blockers: string[] = [];
    if (session.runtime.state !== "connected") blockers.push("runtime_not_connected");
    if (session.status !== "idle") blockers.push(`status_${session.status}`);
    if (session.initializing) blockers.push("initializing");
    if (this.deliveringInputSessionIds.has(session.id) || this.processingQueuedSessionIds.has(session.id)) {
      blockers.push("input_delivery");
    }
    if ((await this.db.listQueuedInputs(session.id)).length > 0) blockers.push("queued_input");
    const latestUser = await this.db.latestUserMessage(session.id);
    const deliveryState = inputDeliveryState(latestUser);
    if (deliveryState === "pending" || deliveryState === "failed") blockers.push("uncertain_input");
    if (await this.db.activeBtwExchange(session.id)) blockers.push("btw_handoff");
    if ((await this.db.listAgentWaits()).some((wait) => wait.actorSessionId === session.id)) {
      blockers.push("orchestration_continuation");
    }
    if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) {
      blockers.push("heavy_command");
    }
    if (blockers.length === 0) {
      try {
        blockers.push(...await this.requireAppServerDriver().hibernationBlockers(session));
      } catch {
        blockers.push("runtime_evidence_unavailable");
      }
    }
    return [...new Set(blockers)];
  }

  async hibernateIdleAppServerSessions(nowMs = Date.now()): Promise<void> {
    if (this.appServerHibernationRunning || !this.sessionDrivers?.has()) return;
    this.appServerHibernationRunning = true;
    try {
      const sessions = (await this.db.listSessions(true))
        .filter((session) =>
          !session.archived &&
          session.runtime !== undefined &&
          session.runtime.state === "connected" &&
          session.status === "idle"
        )
        .sort(compareAppServerRecoveryOrder);
      for (const session of sessions) {
        const lastActivityMs = session.lastActivityAt ? Date.parse(session.lastActivityAt) : Number.NaN;
        if (!Number.isFinite(lastActivityMs) || nowMs - lastActivityMs < this.appServerHibernateMs) continue;
        try {
          await this.hibernateAppServerSession(session);
        } catch {
          // Eligibility can change between observation and stop. A later interval re-evaluates from durable state.
        }
      }
    } finally {
      this.appServerHibernationRunning = false;
    }
  }

  private async hibernateAppServerSession(session: ManagedSession, audit = true): Promise<ManagedSession> {
    return this.serializeRuntimeOperation(session.id, async () => {
      const current = requireSession(await this.db.getSession(session.id));
      return this.hibernateAppServerSessionExclusive(current, audit);
    });
  }

  private async hibernateAppServerSessionExclusive(session: ManagedSession, audit: boolean): Promise<ManagedSession> {
    const blockers = await this.appServerHibernationBlockers(session);
    if (blockers.length > 0) {
      throw new SessionRuntimeActionError(`Session cannot hibernate while ${blockers.join(", ")}`);
    }
    const runtime = await this.requireAppServerDriver().hibernate(session);
    const now = nowIso();
    const current = requireSession(await this.db.getSession(session.id));
    await this.db.upsertSession({ ...current, runtime, status: "idle", initializing: false }, now);
    if (audit) await this.db.addAudit("local", "runtime:hibernate", session.id, "ok", now);
    const updated = requireSession(await this.db.getSession(session.id));
    this.publish("status.changed", session.id, { status: "idle" });
    this.publish("session.updated", session.id, updated);
    return updated;
  }

  private async wakeAppServerSession(session: ManagedSession, audit = true): Promise<ManagedSession> {
    return this.serializeRuntimeOperation(session.id, async () => {
      const current = requireSession(await this.db.getSession(session.id));
      return this.wakeAppServerSessionExclusive(current, audit);
    });
  }

  private async wakeAppServerSessionExclusive(session: ManagedSession, audit = true): Promise<ManagedSession> {
    if (session.runtime?.kind !== "systemd_service") {
      throw new SessionRuntimeActionError("Only app-server sessions can be woken");
    }
    if (session.runtime.state !== "hibernated") {
      throw new SessionRuntimeActionError("Session is not hibernated");
    }
    const updated = await this.resumeAppServerSession(session);
    if (audit) await this.db.addAudit("local", "runtime:wake", session.id, "ok", nowIso());
    return updated;
  }

  private serializeRuntimeOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runtimeOperationTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.runtimeOperationTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.runtimeOperationTails.get(sessionId) === tail) this.runtimeOperationTails.delete(sessionId);
    });
    return result;
  }

  private async performAppServerPlanAction(
    session: ManagedSession,
    planMessage: ChatMessage,
    action: PlanActionChoice,
    plan: string | null
  ): Promise<void> {
    const driver = this.requireAppServerDriver();
    if (action === "stay_in_plan") {
      await driver.choosePlanAction(session, action, { plan: null, clientMessageId: null });
      this.answeredPlanMessageIds.add(planMessage.id);
      const now = nowIso();
      await this.recordInteractionOutcome(planMessage.id, session.id, {
        kind: "plan", status: "answered", decision: action, submittedAt: now
      });
      await this.db.setSessionInputMode(session.id, "plan", now);
      await this.db.setSessionStatus(session.id, "idle", now);
      this.pendingPlanActionStatuses.delete(session.id);
      await this.db.addAudit("local", "plan_action:stay_in_plan", session.id, "ok", now);
      this.publish("status.changed", session.id, { status: "idle" });
      this.publish("session.updated", session.id, await this.db.getSession(session.id));
      return;
    }
    if (!plan) throw new InputModeSwitchError("Pending proposed plan is incomplete");
    const launchOptions = action === "clear_context_implement"
      ? await this.appServerThreadLaunchOptions(session, "default")
      : undefined;
    const text = action === "implement"
      ? PLAN_IMPLEMENTATION_MESSAGE
      : `${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n${plan.trim()}`;
    if (this.deliveringInputSessionIds.has(session.id)) {
      throw new InputDeliveryError("Another input delivery is already in progress for this session");
    }
    const now = nowIso();
    let message = await this.recordSubmittedInput(session, text, "default", now);
    this.publish("message.appended", session.id, message);
    this.deliveringInputSessionIds.add(session.id);
    try {
      message = await this.updateInputDelivery(message, { deliveryPhase: "delivering" });
      const result = await driver.choosePlanAction(session, action, {
        plan,
        clientMessageId: message.id,
        launchOptions
      });
      if (!result.receipt) throw new Error("App-server plan action did not return an input receipt");
      const current = requireSession(await this.db.getSession(session.id));
      await this.db.upsertSession({
        ...current,
        provider: result.provider,
        codexSessionId: result.provider.threadId,
        codexJsonlPath: result.provider.rolloutPath,
        inputMode: "default",
        status: "working"
      }, now);
      const currentMessage = await this.db.latestUserMessage(session.id);
      if (currentMessage?.id === message.id) message = currentMessage;
      message = await this.updateInputDelivery(message, {
        state: "acknowledged",
        deliveryPhase: "acknowledged",
        acknowledgedBy: "app_server_receipt",
        clientMessageId: result.receipt.clientMessageId,
        threadId: result.receipt.threadId,
        turnId: result.receipt.turnId,
        acceptedAt: result.receipt.acceptedAt,
        failureReason: null
      });
      this.answeredPlanMessageIds.add(planMessage.id);
      await this.recordInteractionOutcome(planMessage.id, session.id, {
        kind: "plan", status: "answered", decision: action, submittedAt: result.receipt.acceptedAt
      });
      this.pendingPlanActionStatuses.set(session.id, { status: "working", expiresAtMs: Date.now() + PLAN_ACTION_START_GRACE_MS });
      await this.db.addAudit("local", `plan_action:${action}`, session.id, JSON.stringify({
        clientMessageId: result.receipt.clientMessageId,
        threadId: result.receipt.threadId,
        turnId: result.receipt.turnId
      }), result.receipt.acceptedAt);
      this.publish("message.appended", session.id, message);
      this.publish("status.changed", session.id, { status: "working" });
      this.publish("session.updated", session.id, await this.db.getSession(session.id));
    } catch (error) {
      await this.recordInteractionOutcome(planMessage.id, session.id, {
        kind: "plan",
        status: "failed",
        decision: action,
        submittedAt: nowIso(),
        error: error instanceof Error ? error.message : String(error)
      });
      message = await this.updateInputDelivery(message, {
        state: "failed",
        deliveryPhase: "failed",
        failureCode: "app_server_rejected",
        failureReason: inputDeliveryFailureMessage("app_server_rejected")
      });
      const failedAt = nowIso();
      await this.db.setSessionStatus(session.id, "input_failed", failedAt);
      this.publish("message.appended", session.id, message);
      this.publish("status.changed", session.id, { status: "input_failed" });
      this.publish("session.updated", session.id, await this.db.getSession(session.id));
      throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
    } finally {
      this.deliveringInputSessionIds.delete(session.id);
    }
  }

  private async appServerThreadLaunchOptions(
    session: ManagedSession,
    mode: CollaborationMode
  ): Promise<AgentSessionLaunchOptions> {
    let launchOptions: AgentSessionLaunchOptions;
    if (session.gitWorkspace) {
      if (!this.gitWorkspaces) throw new Error("Managed Git workspaces are unavailable for app-server thread replacement");
      const workspace = await this.gitWorkspaces.getBySession(session.id);
      if (!workspace) throw new Error(`Managed Git workspace is missing for app-server thread replacement: ${session.gitWorkspace.id}`);
      await this.gitWorkspaces.ensureControlPath(workspace);
      launchOptions = managedCodexLaunchOptions(workspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment);
    } else {
      await requireExistingDirectory(session.cwd ?? session.repo.root);
      launchOptions = { environment: this.managedEnvironment };
    }
    const selected = session.models[mode];
    return this.withDocumentLaunchOptions({
      ...launchOptions,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort,
      fastMode: session.fastMode
    }, await this.ensureDocumentScope(session));
  }

  private async resumeAppServerSession(session: ManagedSession): Promise<ManagedSession> {
    try {
      return await this.performAppServerResume(session);
    } catch (error) {
      const startupError = error instanceof Error ? error.message : "App-server recovery failed";
      await this.markAppServerRecoveryFailed(session.id, startupError, error instanceof AppServerRuntimeStoppedError);
      throw error;
    }
  }

  private async performAppServerResume(session: ManagedSession): Promise<ManagedSession> {
    const sourceThreadId = session.provider?.threadId ?? session.codexSessionId;
    if (!sourceThreadId) throw new Error("App-server session does not have a Codex thread id to resume");
    const driver = this.requireAppServerDriver();
    const documentScopeId = await this.ensureDocumentScope(session);
    const activeModel = session.models[session.inputMode];
    let directory: string;
    let launchOptions: AgentSessionLaunchOptions;
    if (session.gitWorkspace) {
      if (!this.gitWorkspaces) throw new Error("Managed Git workspaces are unavailable during app-server recovery");
      const workspace = await this.gitWorkspaces.getBySession(session.id);
      if (!workspace) throw new Error(`Managed Git workspace is missing during app-server recovery: ${session.gitWorkspace.id}`);
      directory = await this.gitWorkspaces.ensureControlPath(workspace);
      launchOptions = managedCodexLaunchOptions(workspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment);
    } else {
      directory = await requireExistingDirectory(session.cwd ?? session.repo.root);
      launchOptions = { environment: this.managedEnvironment };
    }
    const documentOptions = await this.withDocumentLaunchOptions({
      ...launchOptions,
      model: activeModel.model,
      reasoningEffort: activeModel.reasoningEffort,
      fastMode: session.fastMode
    }, documentScopeId);
    const prepared = await this.prepareOrchestratedLaunch(documentOptions);
    const startedAt = nowIso();
    await this.db.setSessionStatus(session.id, "unknown", startedAt);
    await this.db.setSessionInitializing(session.id, true, startedAt);
    this.publish("status.changed", session.id, { status: "unknown" });
    this.publish("session.updated", session.id, await this.db.getSession(session.id));

    let recoveredLaunch: AgentSessionLaunchResult | null = null;
    try {
      let launch: AgentSessionLaunchResult;
      try {
        launch = await driver.resume({
          sessionId: session.id,
          name: sessionName(session),
          cwd: directory,
          options: prepared.options,
          sourceThreadId
        });
      } catch (error) {
        throw new AppServerRuntimeStoppedError(error);
      }
      recoveredLaunch = launch;
      if (launch.sessionId !== session.id) {
        throw new Error(`App-server driver returned the wrong resumed session id: expected ${session.id}, received ${launch.sessionId}`);
      }
      if (launch.provider.threadId !== sourceThreadId) {
        throw new Error(`App-server driver resumed the wrong Codex thread: expected ${sourceThreadId}, received ${launch.provider.threadId ?? "none"}`);
      }
      await launch.ready;
      const current = requireSession(await this.db.getSession(session.id));
      const currentActiveModel = current.models[current.inputMode];
      const rolloutPath = launch.provider.rolloutPath ?? current.provider?.rolloutPath ?? current.codexJsonlPath;
      const resumedSession: ManagedSession = {
        ...current,
        name: session.name ?? sessionName(session),
        cwd: directory,
        provider: { ...launch.provider, rolloutPath },
        runtime: launch.runtime,
        capabilities: launch.capabilities,
        codexSessionId: launch.provider.threadId,
        codexJsonlPath: rolloutPath,
        resourceUnit: launch.runtime.unit,
        startupError: null
      };
      await driver.setPreferences(resumedSession, {
        mode: current.inputMode,
        ...(currentActiveModel.model ? { model: currentActiveModel } : {}),
        ...(current.fastMode === null ? {} : { fastMode: current.fastMode })
      });
      await this.db.upsertSession(resumedSession, nowIso());
      await this.bindOrchestratedLaunch(prepared.capabilityId, session.id);
      const reconciled = await this.db.getSession(session.id);
      const ready = await this.db.setSessionInitializationResult(
        session.id,
        startupReadyStatus(reconciled?.status),
        null,
        nowIso()
      );
      if (!ready) throw new Error(`App-server session disappeared during recovery: ${session.id}`);
      this.publish("session.updated", session.id, ready);
      await this.processQueuedInputs(session.id);
      return ready;
    } catch (error) {
      if (recoveredLaunch) {
        await driver.kill(appServerLaunchSession(recoveredLaunch, sessionName(session), directory)).catch(() => undefined);
        throw new AppServerRuntimeStoppedError(error);
      }
      throw error;
    }
  }

  private async markAppServerRecoveryFailed(
    sessionId: string,
    startupError: string,
    markRuntimeFailed = true
  ): Promise<void> {
    const current = await this.db.getSession(sessionId);
    if (!current) return;
    await this.db.upsertSession({
      ...current,
      runtime: markRuntimeFailed && current.runtime?.kind === "systemd_service"
        ? { ...current.runtime, state: "failed" }
        : current.runtime
    }, nowIso());
    const failed = await this.db.setSessionInitializationResult(sessionId, "startup_failed", startupError, nowIso());
    this.publish("status.changed", sessionId, { status: "startup_failed" });
    if (failed) this.publish("session.updated", sessionId, failed);
  }

  private async persistInitializingAppServerSession(
    launch: AgentSessionLaunchResult,
    name: string,
    cwd: string,
    repoPath: string,
    gitWorkspace: GitWorkspaceSummary | null,
    forkedFrom: SessionForkOrigin | null,
    preferences: Pick<ManagedSession, "inputMode" | "models" | "fastMode" | "fastModeAvailable"> | undefined,
    documentScopeId: string
  ): Promise<ManagedSession> {
    const now = nowIso();
    const session: ManagedSession = {
      id: launch.sessionId,
      name,
      cwd,
      provider: launch.provider,
      runtime: launch.runtime,
      capabilities: launch.capabilities,
      repo: await loadRepoMetadata(repoPath),
      codexSessionId: launch.provider.threadId,
      codexJsonlPath: launch.provider.rolloutPath,
      discoveryConfidence: "high",
      status: "unknown",
      initializing: true,
      startupError: null,
      lastActivityAt: null,
      preview: "",
      recentUserPrompts: [],
      approvalMode: "ask",
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
      gitWorkspace,
      resourceUnit: launch.runtime.unit,
      documentScopeId
    };
    await this.db.upsertSession(session, now);
    const persisted = requireSession(await this.db.setSessionInitializing(session.id, true, now));
    await this.recordTouchedRepository(persisted, now);
    return persisted;
  }

  private requireAppServerDriver(): AgentSessionDriver {
    if (!this.sessionDrivers?.has()) {
      throw new CreateSessionError("App-server sessions are unavailable", 503);
    }
    return this.sessionDrivers.require();
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
    const storedSession = await this.db.getSession(sessionId);
    if (action.type === "kill" && storedSession?.status === "missing") {
      const timestamp = nowIso();
      if (storedSession.agentOwnership?.completedAt && !storedSession.archived) await this.db.markSessionArchived(sessionId, true, timestamp);
      const updated = await this.db.getSession(sessionId) ?? storedSession;
      await this.db.addAudit("local", action.type, sessionId, "already_missing", timestamp);
      this.publish("session.updated", sessionId, updated);
      return updated;
    }
    const session = requireSession(storedSession);
    const driver = this.requireAppServerDriver();
    if (action.type === "extendAgentBudget") return this.operatorExtendAgentBudget(sessionId, action.additionalTokens, action.reason);
    if (action.type === "interrupt") {
      if (session.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(session.gitWorkspace.id, "session interrupted by operator");
      await driver.interrupt(session, null);
      await this.db.setSessionStatus(sessionId, "waiting", nowIso());
      this.publish("status.changed", sessionId, { status: "waiting" });
    }
    if (action.type === "hibernate") await this.hibernateAppServerSession(session, false);
    if (action.type === "wake") await this.wakeAppServerSession(session, false);
    if (action.type === "choosePlanAction") {
      const latestPlanMessage = await this.db.latestPlanReadyMessage(sessionId);
      if (!latestPlanMessage) throw new InputModeSwitchError("No pending proposed plan for this session");
      const selectedPlanMessageId = (action as SessionAction & { messageId?: string }).messageId;
      if (!selectedPlanMessageId || latestPlanMessage.id !== selectedPlanMessageId) {
        throw new InputModeSwitchError("The proposed plan changed before this action was submitted");
      }
      let plan: string | null = null;
      if (action.action !== "stay_in_plan") {
        plan = extractLastCompleteProposedPlan(latestPlanMessage.text);
        if (plan === null) throw new InputModeSwitchError("Pending proposed plan is incomplete");
        const changes = await this.requireDocuments().persistApprovedPlan(await this.ensureDocumentScope(session), latestPlanMessage.sequence, plan);
        if (changes.created.length > 0 || changes.updated.length > 0) this.publishDocumentsUpdated(sessionId, changes);
      }
      await this.performAppServerPlanAction(session, latestPlanMessage, action.action, plan);
    }
    if (action.type === "rename") {
      const name = requireSessionName(action.name);
      await driver.rename(session, name);
      const current = requireSession(await this.db.getSession(sessionId));
      await this.db.upsertSession({ ...current, name }, nowIso());
    }
    if (action.type === "pin") await this.db.setSessionPinned(sessionId, true, nowIso());
    if (action.type === "unpin") await this.db.setSessionPinned(sessionId, false, nowIso());
    if (action.type === "kill") {
      this.readySessionDiscoveryGeneration.delete(sessionId);
      if (session.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(session.gitWorkspace.id, "owning session was killed");
      await driver.kill(session);
      const current = requireSession(await this.db.getSession(sessionId));
      await this.db.upsertSession({ ...current, status: "missing", runtime: current.runtime ? { ...current.runtime, state: "stopped" } : undefined }, nowIso());
    }
    if (action.type === "archiveTranscript") {
      this.readySessionDiscoveryGeneration.delete(sessionId);
      await this.db.markSessionArchived(sessionId, true, nowIso());
    }
    if (action.type === "setInputMode") {
      await driver.setPreferences(session, { mode: action.mode });
      const updatedAt = nowIso();
      const updated = await this.db.setSessionInputMode(sessionId, action.mode, updatedAt);
      await this.db.addAudit("local", "set_input_mode", sessionId, JSON.stringify({ previousMode: session.inputMode, requestedMode: action.mode, switchMethod: "structured_settings", resultingMode: updated?.inputMode ?? null }), updatedAt);
    }
    if (action.type === "setModelSettings") await this.setModelSettings(session, action.mode, action.model, action.reasoningEffort);
    if (action.type === "setApprovalMode") {
      await this.db.setSessionApprovalMode(sessionId, action.mode, nowIso());
      await this.db.addAudit("local", "set_approval_mode", sessionId, JSON.stringify({ mode: action.mode }), nowIso());
    }
    if (action.type === "setFastMode") await this.setFastMode(session, action.enabled);
    if (action.type === "setAgentParent") await this.operatorSetAgentParent(sessionId, action.parentSessionId);
    if (action.type === "retryInputDelivery") await this.retryInputDelivery(session);
    if (action.type === "dismissInputDeliveryFailure") await this.dismissInputDeliveryFailure(session);
    if (action.type === "kill" && session.agentOwnership?.completedAt) await this.db.markSessionArchived(sessionId, true, nowIso());
    await this.db.addAudit("local", action.type, sessionId, "ok", nowIso());
    const updatedSession = await this.db.getSession(sessionId);
    this.publish("session.updated", sessionId, updatedSession);
    if (action.type === "setApprovalMode" && action.mode !== "ask") {
      const pending = await this.getPendingApproval(sessionId);
      if (pending) void this.handleAutomatedApproval(sessionId, pending.messageId);
    }
    return updatedSession;
  }

  async getPendingPlanMessage(sessionId: string): Promise<ChatMessage | null> {
    return this.db.latestPlanReadyMessage(sessionId);
  }

  private async recordInteractionOutcome(
    messageId: string,
    sessionId: string,
    outcome: TranscriptInteractionOutcome
  ): Promise<void> {
    const message = await this.db.getMessage(sessionId, messageId);
    if (!message) return;
    const updated = await this.db.updateMessagePayload(message, { ...message.payload, interactionOutcome: outcome });
    if (updated) this.publish("message.appended", sessionId, updated);
  }

  private async failInputDelivery(message: ChatMessage, reason: InputDeliveryFailureCode): Promise<ChatMessage> {
    const failed = await this.updateInputDelivery(message, {
      state: "failed",
      deliveryPhase: "failed",
      failureCode: reason,
      failureReason: inputDeliveryFailureMessage(reason)
    });
    const failedAt = nowIso();
    await this.db.addAudit("local", "input_delivery_failed", message.sessionId, JSON.stringify({
      promptHash: inputPromptHash(message.sessionId, message.text),
      promptLength: message.text.length,
      reason
    }), failedAt);
    this.publish("message.appended", message.sessionId, failed);
    return failed;
  }

  private async retryInputDelivery(session: ManagedSession): Promise<void> {
    if (this.deliveringInputSessionIds.has(session.id)) throw new InputDeliveryError("Another input delivery is already in progress for this session");
    const message = await this.db.latestUserMessage(session.id);
    const submission = message ? muxpilotSubmission(message) : null;
    const retryableDismissedFailure = submission?.state === "dismissed" && submission.deliveryPhase === "failed";
    if (!message || !submission || (submission.state !== "failed" && !retryableDismissedFailure)) throw new InputDeliveryError("There is no failed input delivery to retry");
    await this.retryAppServerInputDelivery(session, message, submission, this.requireAppServerDriver());
  }

  private async retryAppServerInputDelivery(
    session: ManagedSession,
    message: ChatMessage,
    submission: Record<string, unknown>,
    driver: AgentSessionDriver
  ): Promise<void> {
    const clientMessageId = typeof submission.clientMessageId === "string" && submission.clientMessageId
      ? submission.clientMessageId
      : message.id;
    const mode = collaborationModeFromMessage(message) ?? session.inputMode;
    if (!isInputReadyStatus(session.status) && session.status !== "input_failed") {
      throw new InputDeliveryError("Codex is not ready to retry this input");
    }
    this.deliveringInputSessionIds.add(session.id);
    try {
      const reconciled = await driver.reconcileInput(session, clientMessageId);
      if (!reconciled) {
        await this.db.addAudit("local", "input_delivery_app_server_unresolved", session.id, JSON.stringify({
          promptHash: inputPromptHash(session.id, message.text),
          clientMessageId
        }), nowIso());
        throw new InputDeliveryError("The original client message is still unconfirmed after an authoritative thread read. It was not resent because Codex does not guarantee client-message idempotency.");
      }
      const receipt = reconciled;
      const acknowledged = await this.updateInputDelivery(message, {
        state: "acknowledged",
        deliveryPhase: "acknowledged",
        acknowledgedBy: "app_server_reconciliation",
        clientMessageId: receipt.clientMessageId,
        threadId: receipt.threadId,
        turnId: receipt.turnId,
        acceptedAt: receipt.acceptedAt,
        attemptCount: typeof submission.attemptCount === "number" ? submission.attemptCount + 1 : 2,
        failureCode: null,
        failureReason: null
      });
      const updatedAt = nowIso();
      const failedPlan = isPlanActionInput(message.text) ? (await this.db.listMessages(session.id)).reverse().find((candidate) => {
        const outcome = candidate.payload.interactionOutcome as Partial<TranscriptInteractionOutcome> | undefined;
        return outcome?.kind === "plan" && outcome.status === "failed";
      }) : undefined;
      const failedPlanOutcome = failedPlan?.payload.interactionOutcome as Partial<TranscriptInteractionOutcome> | undefined;
      if (failedPlan && failedPlanOutcome?.decision) {
        await this.recordInteractionOutcome(failedPlan.id, session.id, {
          kind: "plan",
          status: "answered",
          decision: failedPlanOutcome.decision,
          submittedAt: receipt.acceptedAt
        });
      }
      const status = activeInputStatus(mode);
      await this.db.setSessionStatus(session.id, status, updatedAt);
      await this.db.addAudit("local", "input_delivery_reconciled", session.id, JSON.stringify({
        promptHash: inputPromptHash(session.id, message.text),
        clientMessageId,
        threadId: receipt.threadId,
        turnId: receipt.turnId
      }), updatedAt);
      this.publish("message.appended", session.id, acknowledged);
      this.publish("status.changed", session.id, { status });
    } catch (error) {
      throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
    } finally {
      this.deliveringInputSessionIds.delete(session.id);
    }
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
    const updated = await this.db.updateMuxpilotSubmission(message, changes);
    if (!updated) throw new Error("Could not persist input delivery state");
    return updated;
  }

  private appServerDriver(session: ManagedSession): AgentSessionDriver | null {
    if (!this.sessionDrivers) throw new Error("App-server session driver registry is unavailable");
    return this.sessionDrivers.require();
  }

  private pendingPlanActionStatus(sessionId: string): SessionStatus | null {
    const pending = this.pendingPlanActionStatuses.get(sessionId);
    if (!pending) return null;
    if (pending.expiresAtMs > Date.now()) return pending.status;
    this.pendingPlanActionStatuses.delete(sessionId);
    return null;
  }

  private async processQueuedInputs(sessionId: string): Promise<void> {
    if (this.processingQueuedSessionIds.has(sessionId) || this.deliveringInputSessionIds.has(sessionId)) return;
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
      if (session.status === "input_failed") return;
      if (session.gitWorkspace && await this.heavyCommandQueue?.hasActive(session.gitWorkspace.id)) return;
      if (!queuedInputMatchesSession(input, session)) {
        await this.markQueuedInputFailed(input, "Session source changed before this input was sent");
        return;
      }

      const readySession = readyAppServerInputSession(session);
      if (!readySession) return;

      const sending = { ...input, status: "sending" as const, error: null, updatedAt: nowIso() };
      await this.db.updateQueuedInput(sending);
      this.publish("queue.updated", sessionId, { queuedInputs: await this.db.listQueuedInputs(sessionId) });

      try {
        const now = nowIso();
        const queuedSubmission = await this.db.queuedSubmissionMessage(session.id, sending.id);
        const queuedSubmissionState = queuedSubmission ? muxpilotSubmission(queuedSubmission) : null;
        const reusedSteerSubmission = queuedSubmissionState?.deliveryPhase === "queued" ? queuedSubmission : null;
        let message = reusedSteerSubmission
          ? await this.updateInputDelivery(reusedSteerSubmission, {
              state: "pending",
              deliveryPhase: "persisted",
              lastAttemptAt: now,
              failureCode: null,
              failureReason: null
            })
          : await this.recordSubmittedInput(
              session,
              sending.text,
              sending.mode,
              now,
              sending.id,
              sending.actorSessionId,
              "turn_start",
              sending.content
            );
        this.publish("message.appended", sessionId, message);
        message = await this.deliverSubmittedInput(readySession, message, sending.mode);
        await this.db.updateQueuedInput({ ...sending, status: "sent", updatedAt: now, sentAt: now });
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

  private async markQueuedInputFailed(input: QueuedInput, error: string): Promise<void> {
    const failed = { ...input, status: "failed" as const, error, updatedAt: nowIso(), sentAt: null };
    await this.db.updateQueuedInput(failed);
    await this.db.addAudit("local", "queued_input_failed", input.sessionId, error, failed.updatedAt);
    this.publish("queue.updated", input.sessionId, { queuedInputs: await this.db.listQueuedInputs(input.sessionId) });
  }

  private async setFastMode(session: ManagedSession, enabled: boolean): Promise<void> {
    if (!canToggleFastMode(session.status)) throw new FastModeSwitchError("Fast mode cannot be changed in the sessions current state");
    if (session.fastModeAvailable === false) throw new FastModeSwitchError("Fast mode is not available for the active Codex model");
    try {
      await this.requireAppServerDriver().setPreferences(session, { fastMode: enabled });
    } catch (error) {
      throw new FastModeSwitchError(error instanceof Error ? error.message : String(error));
    }
    const updatedAt = nowIso();
    await this.db.setSessionFastMode(session.id, enabled, updatedAt);
    await this.db.addAudit("local", "set_fast_mode", session.id, JSON.stringify({ enabled, method: "structured_settings" }), updatedAt);
  }

  private async setModelSettings(
    session: ManagedSession,
    mode: CollaborationMode,
    requestedModel: string,
    reasoningEffort: string | null
  ): Promise<void> {
    const driver = this.appServerDriver(session);
    if (!driver) throw new ModelSettingsError("Model selection is available only for app-server sessions");
    const catalog = await this.codexModelCatalog();
    const model = requireCatalogModel(catalog, requestedModel, reasoningEffort);
    const current = requireSession(await this.db.getSession(session.id));
    const active = current.inputMode === mode;
    if (active && current.runtime?.kind === "systemd_service" && current.runtime.state === "hibernated") {
      throw new ModelSettingsError("Wake this session before changing its active model");
    }
    const fastModeAvailable = active ? codexFastModeAvailable(catalog.models, model.model) ?? false : undefined;
    const disableFastMode = active && current.fastMode === true && fastModeAvailable === false;
    if (active) {
      await driver.setPreferences(current, {
        mode,
        model: { model: model.model, reasoningEffort },
        ...(disableFastMode ? { fastMode: false } : {})
      });
    }
    const updatedAt = nowIso();
    const updated = await this.db.setSessionModelSettings(
      session.id,
      mode,
      model.model,
      reasoningEffort,
      updatedAt,
      fastModeAvailable,
      disableFastMode ? false : undefined
    );
    if (!updated) throw new ModelSettingsError("The session disappeared after Codex accepted the model change");
    await this.db.addAudit("local", "set_model_settings", session.id, JSON.stringify({
      mode,
      model: model.model,
      reasoningEffort,
      appliedToActiveMode: active,
      fastModeDisabled: disableFastMode
    }), updatedAt);
  }

  private async defaultAppServerPreferences(): Promise<Pick<ManagedSession, "inputMode" | "models" | "fastMode" | "fastModeAvailable">> {
    const [stored, catalog] = await Promise.all([
      this.db.getGlobalModelSettings(),
      this.codexModelCatalog()
    ]);
    const models = effectiveModelSelections(stored, catalog.defaults);
    return {
      inputMode: "default",
      models,
      fastMode: null,
      fastModeAvailable: codexFastModeAvailable(catalog.models, models.default.model)
    };
  }
  private async findLiveSessionByRecoveryIdentity(identity: string): Promise<ManagedSession | null> {
    for (const session of await this.db.listSessions(true)) {
      if (recoveryIdentityForSession(session) === identity && await this.isLiveAppServerRuntime(session)) return session;
    }
    return null;
  }

  private async findLiveSessionByCodexSessionId(codexSessionId: string): Promise<ManagedSession | null> {
    for (const session of await this.db.listSessions(true)) {
      if (session.codexSessionId === codexSessionId && await this.isLiveAppServerRuntime(session)) return session;
    }
    return null;
  }

  private async isLiveAppServerRuntime(session: ManagedSession): Promise<boolean> {
    if (!session.runtime) return false;
    try {
      const evidence = await this.requireAppServerDriver().runtimeEvidence(session);
      return evidence.activeState === "active" && evidence.socketPresent;
    } catch {
      return false;
    }
  }

  private async recordTouchedRepository(session: ManagedSession, updatedAt: string): Promise<void> {
    const candidate = session.gitWorkspace?.entryPath ?? session.repo.root ?? session.cwd;
    const path = await existingDirectoryPath(candidate);
    if (!path) return;
    await this.db.upsertTouchedRepository(
      {
        path,
        label: session.repo.name || basename(path),
        repoRoot: session.repo.root,
        branch: normalizeGitWorkspaceSummary(session.gitWorkspace)?.targetBranch ?? session.repo.branch,
        lastActivityAt: session.lastActivityAt
      },
      updatedAt
    );
  }

  private publish(
    type: "session.updated" | "message.appended" | "status.changed" | "notification.created" | "queue.updated" | "documents.updated",
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export class ModelSettingsError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class InputDeliveryError extends Error {
  readonly statusCode = 409;
}

export class SessionRuntimeActionError extends Error {
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

export class AgentSessionError extends Error {
  readonly statusCode = 409;
}

function userSystemdLaunchEnvironment(environment: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (environment[key]) result[key] = environment[key];
  }
  return result;
}

function isLiveAgentSession(session: ManagedSession): boolean {
  return Boolean(session.agentOwnership && !session.agentOwnership.completedAt && !session.archived && session.status !== "missing");
}

function isLiveManagedSession(session: ManagedSession): boolean {
  return !session.agentOwnership?.completedAt && !session.archived && session.status !== "missing";
}

function liveAgentDescendants(sessions: ManagedSession[], rootSessionId: string): ManagedSession[] {
  return sessions.filter((session) => session.agentOwnership?.rootSessionId === rootSessionId && isLiveAgentSession(session));
}

function agentDescendants(sessions: ManagedSession[], parentSessionId: string): ManagedSession[] {
  const result: ManagedSession[] = [];
  const pending = [parentSessionId];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const session of sessions) {
      if (session.agentOwnership?.parentSessionId !== parent || seen.has(session.id)) continue;
      seen.add(session.id);
      result.push(session);
      pending.push(session.id);
    }
  }
  return result;
}

function completedAgentSessionHasVisibleAncestor(
  session: ManagedSession,
  allSessions: ManagedSession[],
  includeArchived: boolean
): boolean {
  if (!session.agentOwnership?.completedAt) return false;
  const byId = new Map(allSessions.map((candidate) => [candidate.id, candidate]));
  let current: ManagedSession = session;
  const seen = new Set<string>();
  while (current.agentOwnership && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.agentOwnership.parentSessionId);
    if (!parent || (!includeArchived && parent.archived)) return false;
    if (parent.status !== "missing") return true;
    if (!parent.agentOwnership?.completedAt) return false;
    current = parent;
  }
  return false;
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

function btwDocumentNotice(exchangeId: string, changes: BtwDocumentChanges): string {
  return [
    "<environment_context>",
    "  <muxpilot_document_notice>",
    `    ${JSON.stringify({ exchangeId, created: changes.created, updated: changes.updated })}`,
    "  </muxpilot_document_notice>",
    "  <instruction>This is internal additive context. Read the changed session documents now, reconcile them with the latest operator instructions, keep them current, and continue unfinished work without a standalone acknowledgement.</instruction>",
    "</environment_context>"
  ].join("\n");
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

function numericSubmissionField(submission: Record<string, unknown>, field: string): number {
  const value = submission[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function inputPromptHash(sessionId: string, text: string): string {
  return stableId(`${sessionId}:${text}`);
}

function inputDeliveryFailureMessage(reason: InputDeliveryFailureCode): string {
  if (reason === "session_unavailable") return "The session became unavailable before the input could be replayed.";
  if (reason === "app_server_rejected") return "Codex app-server did not accept the input.";
  return "Codex app-server did not acknowledge the input.";
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
  for (const candidate of [session.name, session.repo.name, "restored"]) {
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
  const skillHome = managedEnvironment.MUXPILOT_SKILL_HOME ?? codexHome;
  const helperDir = skillHome ? join(skillHome, "skills", "muxpilot-git-workflow", "scripts") : null;
  const brokerSocketPath = managedEnvironment.MUXPILOT_GIT_BROKER_SOCKET;
  const brokerSocketRoot = brokerSocketPath
    && isAbsolute(brokerSocketPath)
    && basename(brokerSocketPath) === "broker.sock"
    && basename(dirname(brokerSocketPath)) === "git-workflow-broker"
    ? dirname(brokerSocketPath)
    : null;
  const implementationRoot = workspace.implementationRoot ?? worktreeRoot ?? join(summary.repoRoot, ".muxpilot-worktrees", workspace.id);
  const dependencies = reusableDependencyLinks(summary.dependencyLinks ?? []);
  return {
    isolatedWorkspace: true,
    writableRoots: [
      workspace.controlPath,
      brokerSocketRoot,
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
      "For change or build tasks, first resolve the intended target and complete any required fixed-target authorization and retarget, then announce the workflow action, run the begin helper, and perform every repository content write in its short-lived worktree.",
      helperDir
        ? `Workflow helpers: begin with node ${JSON.stringify(join(helperDir, "muxpilot-git-begin.mjs"))}; inspect status with node ${JSON.stringify(join(helperDir, "muxpilot-git-status.mjs"))}; change target with node ${JSON.stringify(join(helperDir, "muxpilot-git-target.mjs"))}; finalize with node ${JSON.stringify(join(helperDir, "muxpilot-git-finish.mjs"))}.`
        : "Use the helper directory provided by the workflow environment.",
      "Workflow status is authoritative for the current target after a retarget.",
      "For answers, plans, reviews, and diagnosis, inspect the repository directly without creating a worktree.",
      "Before repository work, inspect applicable repository instructions from the entry path because the control directory is not the project root.",
      "Before integration, repeatedly self-review the complete diff, fix every finding, run focused file/module checks, and run any full build required by repository guidance until the final committed candidate is clean and builds successfully. Repository-required builds are authorized validation for that repository. Do not treat this same-agent self-review as a PR-style review. Run other repository-wide scans or test suites only when the user explicitly requests them, or when the user explicitly requests a PR-style review of a branch or ref.",
      "Treat a command as heavyweight if it covers an entire repository, workspace, application, package, or multi-project configuration; performs static-analysis, security, dependency, or container-image scanning such as Semgrep, CodeQL, or Trivy; starts Docker or Docker Compose; launches multiple workers, shards, or projects; produces a production bundle; or is reasonably expected to run longer than one minute, use more than about 1 GiB of memory, or sustain multiple CPU cores. Selected-file lint, syntax-only checks, and one explicitly selected test file or test case without parallel workers are normally not heavyweight. When uncertain, treat the command as heavyweight. Run every heavyweight command through muxpilot-git-run.mjs --heavy -- <command>. The wrapper schedules an already-authorized command; it does not authorize repository-wide validation, and its availability is not a reason to broaden a focused check.",
      "If the heavyweight wrapper reports QUEUED_NOT_RUN, use $muxpilot-heavy-command-queue. The command did not run; do not poll or retry it.",
      "If the heavyweight wrapper reports RUNNING_DEFERRED, use $muxpilot-heavy-command-queue, preserve its run_released event, end the turn immediately, and wait for muxpilot's run_completed continuation. Do not poll or overlap repository work.",
      "User instructions take priority over muxpilot guardrails. A direct invocation names a skill with $skill-name or unambiguous wording such as 'use the review skill'; automatic skill selection is not direct invocation. When a directly invoked skill's instruction body explicitly directs an action that conflicts with a muxpilot guard, treat the invocation itself as operation-scoped authorization for that action even if the skill asks for separate authorization. The skill need not name the guard. Map the action to every affected guard, name each exact guard and consequence, announce that the skill invocation supplies authorization, and proceed without pausing for redundant confirmation. This authorization covers only the named skill's current invocation and its explicitly directed actions; broad capability descriptions, undeclared actions, later operations, and automatically selected skills do not qualify. For every other guard conflict, obtain explicit confirmation for the exact guards before bypassing them. Platform safety, sandbox, permission, and security approval requirements are not muxpilot guards and cannot be bypassed this way.",
      "When a change request creates or selects a local branch for implementation, treat that destination branch as the intended session target even if the user does not explicitly say to change the target; a source ref such as origin/dev is only the start point. If it differs from workflow status, before creating the branch or beginning implementation name the fixed-target guard and explain that current and future task commits will integrate there. Obtain separate explicit confirmation for the fixed-target bypass unless a directly invoked skill explicitly directs that retarget, in which case its invocation supplies operation-scoped authorization. An active worktree must repeat focused checks and self-review after retargeting before integration.",
      "Never use an implementation worktree's state to claim that another checkout is clean or dirty; inspect the actual checkout before reporting its working-copy state.",
      "If a requested write is outside the sandbox's writable roots, use normal approval or escalation instead of refusing it as out of scope.",
      "Shared dependency links are writable for test caches. Before installing or changing dependencies, localize the relevant link with the dependency helper.",
      "Create clean atomic commits and run the finish helper before reporting completion. Report the integrated commit and the focused checks and repository-required build that succeeded."
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
    repoBranch: workspace?.targetBranch ?? session.repo.branch,
    cwd: session.cwd,
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
  return session.name.trim() || session.repo.name || "session";
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
  if (latestQuestionMessage.payload.interactionOutcome) return null;
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

function readyAppServerInputSession(session: ManagedSession): ManagedSession | null {
  if (
    session.initializing ||
    session.startupError ||
    session.runtime?.kind !== "systemd_service" ||
    session.runtime.state !== "connected" ||
    !isInputReadyStatus(session.status)
  ) return null;
  return session;
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

function extractLastCompleteProposedPlan(text: string): string | null {
  const openTag = "<proposed_plan>";
  const closeTag = "</proposed_plan>";
  let cursor = 0;
  let plan: string | null = null;
  while (cursor < text.length) {
    const openIndex = text.indexOf(openTag, cursor);
    if (openIndex === -1) break;
    const contentStart = openIndex + openTag.length;
    const closeIndex = text.indexOf(closeTag, contentStart);
    if (closeIndex === -1) break;
    plan = text.slice(contentStart, closeIndex)
      .replace(/^(?:[ \t]*\r?\n)+/, "")
      .replace(/(?:\r?\n[ \t]*)+$/, "");
    cursor = closeIndex + closeTag.length;
  }
  return plan;
}

function isPlanActionInput(text: string): boolean {
  return (
    text === "Yes, implement the plan" ||
    text === "Yes, clear context and implement" ||
    text === "No, stay in plan mode"
  );
}

const NONE_OF_THE_ABOVE_ANSWER = "None of the above";

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

export function sessionChanged(previous: ManagedSession, next: ManagedSession): boolean {
  return JSON.stringify(sessionDiscoverySnapshot(previous)) !== JSON.stringify(sessionDiscoverySnapshot(next));
}

function sessionDiscoverySnapshot(session: ManagedSession): Record<string, unknown> {
  return {
    name: session.name,
    cwd: session.cwd,
    runtime: session.runtime ?? null,
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
    gitWorkspace: session.gitWorkspace,
    documentScopeId: session.documentScopeId ?? null
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

function effectiveModelSelections(
  stored: SessionModelSelections,
  defaults: SessionModelSelections
): SessionModelSelections {
  const selection = (mode: CollaborationMode): SessionModelSettings => stored[mode].model
    ? stored[mode]
    : defaults[mode];
  return { default: selection("default"), plan: selection("plan") };
}

function requireCatalogModel(
  catalog: CodexModelCatalogResponse,
  requestedModel: string,
  reasoningEffort: string | null
): CodexModel {
  if (catalog.models.length === 0) {
    throw new ModelSettingsError("Codex model options are temporarily unavailable", 503);
  }
  const model = catalog.models.find((candidate) => candidate.model === requestedModel || candidate.id === requestedModel);
  if (!model) throw new ModelSettingsError("The selected Codex model is unavailable");
  const efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if ((reasoningEffort === null && efforts.length > 0) || (reasoningEffort !== null && !efforts.includes(reasoningEffort))) {
    throw new ModelSettingsError("The selected reasoning effort is unavailable for this model");
  }
  return model;
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

function startupReadyStatus(status: SessionStatus | undefined): SessionStatus {
  if (!status || status === "unknown" || status === "missing" || status === "startup_failed") return "waiting";
  return status;
}

function appServerLaunchSession(launch: AgentSessionLaunchResult, name: string, cwd: string): ManagedSession {
  return {
    id: launch.sessionId,
    name,
    cwd,
    provider: launch.provider,
    runtime: launch.runtime,
    capabilities: launch.capabilities
  } as ManagedSession;
}

function isRecoverableAppServerSession(session: ManagedSession): boolean {
  return !session.archived
    && session.runtime?.kind === "systemd_service"
    && (session.runtime.state === "connected" || session.runtime.state === "starting")
    && Boolean(session.provider?.threadId ?? session.codexSessionId);
}

function compareAppServerRecoveryOrder(left: ManagedSession, right: ManagedSession): number {
  const leftActivity = left.lastActivityAt ? Date.parse(left.lastActivityAt) : Number.NEGATIVE_INFINITY;
  const rightActivity = right.lastActivityAt ? Date.parse(right.lastActivityAt) : Number.NEGATIVE_INFINITY;
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;
  return left.id.localeCompare(right.id);
}

class AppServerRuntimeStoppedError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "App-server recovery failed");
    this.name = "AppServerRuntimeStoppedError";
  }
}

function requireSession(session: ManagedSession | null): ManagedSession {
  if (!session) throw new Error("Session not found");
  if (session.status === "missing") throw new Error("Session runtime is no longer available");
  return session;
}

function requireLiveAgentSession(session: ManagedSession | null): ManagedSession {
  if (!session || !session.agentOwnership || session.agentOwnership.completedAt || session.archived || session.status === "missing") {
    throw new AgentSessionError("This action requires a live agent-managed session");
  }
  return session;
}

function requireAgentGuardReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new AgentSessionError("Agent guard changes require a reason");
  if (normalized.length > 1_000) throw new AgentSessionError("Agent guard reasons cannot exceed 1,000 characters");
  return normalized;
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
    requestId: jsonRpcRequestIdValue(approval.requestId) ?? undefined,
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
    createdAt: stringValue(approval.createdAt) ?? message.timestamp,
    reviewStatus: approval.reviewStatus === "reviewing" || approval.reviewStatus === "escalated" ? approval.reviewStatus : undefined,
    reviewerModel: stringValue(approval.reviewerModel) ?? undefined,
    reviewerExplanation: stringValue(approval.reviewerExplanation) ?? undefined
  };
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
    requestId: jsonRpcRequestIdValue(question.requestId) ?? undefined,
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

function jsonRpcRequestIdValue(value: unknown): string | number | null {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
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

function unavailableSessionCapabilities(): SessionCapabilities {
  return {
    start: false,
    sendMessage: false,
    steer: false,
    resume: false,
    fork: false,
    verifiedInput: false,
    interrupt: false,
    kill: false,
    approvals: false,
    questions: false,
    planActions: false,
    fastMode: false,
    terminalAttach: false,
    hibernate: false
  };
}
