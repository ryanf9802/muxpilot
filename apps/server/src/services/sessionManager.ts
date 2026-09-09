import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  AgentSessionOwnership,
  ApprovalDecision,
  ApprovalRequest,
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
  SessionDriverKind,
  SessionModelSettings,
  SessionModelSelections,
  SessionStatus,
  SessionTransferImportMapping,
  SessionTransferImportResult,
  TranscriptPageResponse,
  TranscriptSearchResponse,
  TmuxPane
} from "@muxpilot/core";
import { canToggleFastMode, hasCompleteProposedPlan, highestPrioritySession, isValidSessionName, normalizeGitWorkspaceSummary, normalizeSessionName, sessionHistoryIdentity } from "@muxpilot/core";
import type { AppDatabase, StoredGitWorkspace } from "../db/database.js";
import { CodexSessionStore, type CodexSessionFile } from "../codex/codexSessionStore.js";
import { PARSER_VERSION, appendSkillNamesForDisplay, parseCodexJsonl } from "../codex/parser.js";
import {
  interactiveApprovalKeys,
  parseInteractiveApprovalPrompt,
  type InteractiveApprovalPrompt
} from "../codex/approvalPrompt.js";
import {
  composerContainsInput,
  composerHasInput,
  inputVerificationCaptureLines,
  InputTransportError,
  type InputTransportResult,
  isCodexStartupFailureCapture,
  TmuxAdapter
} from "../tmux/tmuxAdapter.js";
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
import type { CodexProcessInfo } from "../codex/codexProcessResolver.js";
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
interface ActivitySummaryScheduler {
  schedule(sessionId: string): void;
  stop(): void;
}

interface CodexProcessLookup {
  resolveForPane(panePid: number): Promise<CodexProcessInfo | null>;
}

interface CodexMetadataLookup {
  listModels(): Promise<CodexModel[]>;
  catalog(): Promise<CodexModelCatalogResponse>;
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
  | "paste_not_observed"
  | "submit_not_accepted"
  | "no_codex_acknowledgement"
  | "composer_changed"
  | "unverified_legacy_submission"
  | "session_unavailable"
  | "app_server_rejected"
  | "tmux_failed";

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

  constructor(
    private readonly db: AppDatabase,
    private readonly tmux: TmuxAdapter,
    private readonly codexStore: CodexSessionStore,
    private readonly events: EventBus,
    private readonly discoveryIntervalMs: number,
    private readonly parserIntervalMs: number,
    private readonly approvalKeys: ApprovalKeyMap,
    private readonly inputModeCycleKeys: string[],
    private readonly documents: SessionDocumentService,
    private readonly activitySummarizer: ActivitySummaryScheduler | null = null,
    private readonly codexProcessLookup: CodexProcessLookup | null = null,
    private readonly gitWorkspaces: GitWorkspaceManager | null = null,
    private readonly codexHome: string | null = process.env.CODEX_HOME ?? null,
    private readonly gitWorktreeRoot: string | null = null,
    private readonly managedEnvironment: Record<string, string> = {},
    private readonly codexMetadata: CodexMetadataLookup | null = null,
    private readonly sessionDrivers: SessionDriverRegistry | null = null,
    private readonly appServerHibernateMs = 900_000,
    private readonly defaultSessionDriver: SessionDriverKind = "codex_tmux"
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
      sourceCwd: session.tmux.cwd
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
    const ready = session.driverKind === "codex_app_server"
      ? readyAppServerInputSession(session)
      : await this.readyLiveSession(session);
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
    const ready = session.driverKind === "codex_app_server"
      ? readyAppServerInputSession(session)
      : await this.readyLiveSession(session);
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
    const instruction = "Use built-in Codex subagents for routine bounded delegation, especially standard code-review passes. Do not create a nested muxpilot session merely to perform a review in parallel; if built-in subagents are unavailable, keep the review in the current session. Use the muxpilot_sessions tools for delegated work only when the operator explicitly requests a nested muxpilot session or the work is durable and benefits from independent monitoring and its own resource scope. Agent-created muxpilot children must use fresh context. Never poll a muxpilot child: arm wait_for_sessions, then end the turn immediately. If muxpilot state appears inconsistent, compare its record with the raw tmux, process, and Codex file tools; report the evidence and do not attempt a workaround without operator direction. Security approvals remain operator-only.";
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
    if (session.driverKind !== "codex_app_server" && this.managedEnvironment.MUXPILOT_SESSION_SCOPES_AVAILABLE === "1") {
      await this.db.setSessionResourceScope(sessionId, sessionScopeName(capabilityId), nowIso());
    }
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
    if (appServerDriver) {
      if (
        session.archived ||
        session.initializing ||
        session.runtime?.kind !== "systemd_service" ||
        session.runtime.state !== "connected" ||
        (!isInputReadyStatus(session.status) && session.status !== "queued" && session.status !== "running" && session.status !== "working")
      ) return false;
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
    const ready = await this.readyLiveSession(session);
    if (!ready) return false;
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
    this.deliveringInputSessionIds.add(sessionId);
    try {
      try {
        await this.sendRawInput(ready, message);
      } catch (error) {
        if (!(error instanceof InputTransportError) || error.reason !== "composer_changed") throw error;
        const pane = await this.livePane(ready);
        await this.tmux.submitComposedInput(pane.paneId, codexTerminalUserText(message));
      }
      const now = nowIso();
      const status = activeInputStatus(ready.inputMode);
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
    sessionIds: string[],
    driverKind?: SessionDriverKind
  ): Promise<RestoreSessionRecoveryResponse> {
    if (driverKind === "codex_tmux") this.tmux.requireAvailable();
    const incident = await this.getSessionRecoveryIncident();
    if (!incident || incident.id !== incidentId) throw new SessionRestoreError("Recovery batch is no longer available");
    const selected = new Set(sessionIds);
    const candidates = incident.sessions.filter((candidate) => selected.has(candidate.sessionId));
    if (candidates.length === 0) throw new SessionRestoreError("Select at least one session to restore", 400);
    const results: RestoreSessionRecoveryResult[] = [];
    const failedIds = new Set<string>();
    for (const candidate of candidates) {
      try {
        const restored = await this.restoreSession(candidate.sessionId, driverKind);
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

  stop(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.parserTimer) clearInterval(this.parserTimer);
    if (this.appServerHibernateTimer) clearInterval(this.appServerHibernateTimer);
    this.appServerHibernateTimer = null;
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

    for (const session of await this.db.listSessions(true)) {
      if (session.driverKind !== "codex_app_server" || !session.codexSessionId) continue;
      const rollout = codexFiles.find((file) => file.sessionId === session.codexSessionId);
      if (!rollout) continue;
      codexClaims.add(rollout.path);
      if (session.codexJsonlPath === rollout.path && session.provider?.rolloutPath === rollout.path) continue;
      const updated = {
        ...session,
        provider: { kind: "codex" as const, threadId: session.codexSessionId, rolloutPath: rollout.path },
        codexJsonlPath: rollout.path,
        transcriptSyncing: true
      };
      await this.db.upsertSession(updated, now, true);
      this.publish("session.updated", session.id, await this.db.getSession(session.id) ?? updated);
    }

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
      let inputMode =
        (await detectLiveCollaborationMode(pane, (paneId, lines) => this.tmux.capturePane(paneId, lines, false))) ??
        existing?.inputMode ??
        "default";
      const rawInferredStatus = await inferStatus(pane, existing?.status, (paneId, lines) => this.tmux.capturePane(paneId, lines, false));
      const liveApprovalPrompt =
        rawInferredStatus !== "approval"
          ? null
          : await this.corroboratedLiveApproval(pane, (await this.db.activeApprovalContext(lookupId)).messages);
      const inferredStatus =
        rawInferredStatus === "approval" && !liveApprovalPrompt
          ? rejectedApprovalFallbackStatus(pane, existing?.status)
          : rawInferredStatus;
      let latestUserMessage = await this.db.latestUserMessage(lookupId);
      const latestTurnLifecycleMessage = await this.db.latestTurnLifecycleMessage(lookupId);
      latestUserMessage = await this.reconcileInputDeliveryState(
        lookupId,
        pane,
        latestUserMessage,
        latestTurnLifecycleMessage,
        inferredStatus,
        inputMode
      );
      if (isPendingMuxpilotSubmission(latestUserMessage, latestTurnLifecycleMessage)) {
        inputMode = latestUserMessage ? collaborationModeFromMessage(latestUserMessage) ?? inputMode : inputMode;
      }
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
      const heavyCommandStatus = !startupError && isInputReadyStatus(effectiveStatus) && activeGitWorkspace
        ? await this.heavyCommandQueue?.sessionStatusForWorkspace(activeGitWorkspace.id) ?? null
        : null;
      const projectedStatus = heavyCommandStatus ?? effectiveStatus;
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
        forkedFrom: existing?.forkedFrom ?? null,
        documentScopeId: existing?.documentScopeId ?? activeGitWorkspace?.id ?? null
      };

      if (effectiveStatus === "approval" && liveApprovalPrompt) {
        this.liveApprovals.set(
          sessionId,
          materializeInteractiveApproval(session, liveApprovalPrompt.prompt, liveApprovalPrompt.contextMessage)
        );
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
        await this.resolveRememberedRepositoryApproval(session, liveApprovalPrompt.prompt);
      }
    }

    for (const session of await this.db.listSessions(true)) {
      if (session.driverKind === "codex_app_server") continue;
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
      if (
        session.driverKind !== "codex_app_server" &&
        !hasOffset &&
        (await this.db.latestMessageSequence(session.id)) > 0
      ) {
        await this.db.clearSessionTranscript(session.id);
      }
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
    const tmuxUnavailableReason = withOrigin.driverKind !== "codex_app_server"
      ? this.tmux.unavailableReason()
      : null;
    return this.withResourceUsage({
      ...withOrigin,
      status: tmuxUnavailableReason
        ? "missing"
        : !withOrigin.agentOwnership?.completedAt && withOrigin.agentOwnership?.budgetExhaustedAt
          ? "blocked"
          : withOrigin.status,
      runtimeUnavailableReason: tmuxUnavailableReason,
      capabilities: tmuxUnavailableReason ? unavailableSessionCapabilities() : withOrigin.capabilities,
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

  async restoreSession(sessionId: string, driverKind?: SessionDriverKind): Promise<{ session: ManagedSession; restored: boolean }> {
    if (driverKind === "codex_tmux") this.tmux.requireAvailable();
    const initial = await this.db.getSession(sessionId);
    if (!initial) throw new SessionNotFoundError("Session not found");
    if (!initial.codexSessionId) throw new SessionRestoreError("Session does not have a Codex session id to resume");
    const key = recoveryIdentityForSession(initial);
    const prior = this.restoreLocks.get(key) ?? Promise.resolve();
    const restore = prior.catch(() => undefined).then(() => this.restoreSessionUnlocked(sessionId, key, driverKind));
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
    restoreIdentity: string,
    requestedDriverKind?: SessionDriverKind
  ): Promise<{ session: ManagedSession; restored: boolean }> {
    const source = await this.db.getSession(sessionId) ??
      (await this.db.listSessions(true)).find((session) => recoveryIdentityForSession(session) === restoreIdentity) ?? null;
    if (!source) throw new SessionNotFoundError("Session not found");
    if (!source.codexSessionId) throw new SessionRestoreError("Session does not have a Codex session id to resume");

    const live = await this.findLiveSessionByRecoveryIdentity(restoreIdentity);
    if (live) {
      if (live.driverKind === "codex_app_server") {
        const session = await this.resumeAppServerSession(live);
        if (session.archived) await this.db.markSessionArchived(session.id, false, nowIso());
        const updated = requireSession(await this.db.getSession(session.id));
        this.publish("session.updated", updated.id, updated);
        return { session: updated, restored: false };
      }
      if (live.archived) await this.db.markSessionArchived(live.id, false, nowIso());
      const session = requireSession(await this.db.getSession(live.id));
      this.publish("session.updated", session.id, session);
      return { session, restored: false };
    }

    const restoreDriver = requestedDriverKind ?? "codex_app_server";
    if (restoreDriver === "codex_app_server") {
      if (!this.sessionDrivers?.has("codex_app_server")) {
        throw new SessionRestoreError("Codex app-server is unavailable; explicitly choose the tmux fallback to restore this session");
      }
      const restored = await this.resumeAppServerSession(source);
      await this.db.markSessionArchived(restored.id, false, nowIso());
      await this.db.addAudit("local", "restore_session:codex_app_server", source.id, "ok", nowIso());
      const updated = requireSession(await this.db.getSession(restored.id));
      this.publish("session.updated", updated.id, updated);
      return { session: updated, restored: true };
    }

    this.tmux.requireAvailable();

    const storedGitWorkspace = await this.gitWorkspaces?.getBySession(source.id) ?? null;
    const cwd = storedGitWorkspace
      ? await this.gitWorkspaces!.ensureControlPath(storedGitWorkspace)
      : await requireExistingDirectory(source.repo.root ?? source.tmux.cwd);
    const launchWorkspace = storedGitWorkspace
      ? await this.gitWorkspaces!.get(storedGitWorkspace.id) ?? storedGitWorkspace
      : null;
    const name = restoreSessionName(source);
    const documentScopeId = await this.ensureDocumentScope(source);
    const documentOptions = await this.withDocumentLaunchOptions(
      launchWorkspace
        ? managedCodexLaunchOptions(launchWorkspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment)
        : { environment: this.managedEnvironment },
      documentScopeId
    );
    const prepared = await this.prepareOrchestratedLaunch(documentOptions);
    const launch = await this.tmux.createCodexResumeWindowInMuxpilotSession(
      cwd,
      name,
      source.codexSessionId,
      prepared.options
    );
    let session = await this.rebindRestoredSession(source, launch.pane);
    session = await this.bindOrchestratedLaunch(prepared.capabilityId, session.id);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "restore_session", source.id, "ok", nowIso());
    this.publish("session.updated", session.id, session);
    return { session, restored: true };
  }

  async importPortableSession(
    portable: PortableSession,
    transcript: Buffer,
    mapping: SessionTransferImportMapping,
    importedDocuments: SessionDocumentSnapshot[] | null = null
  ): Promise<SessionTransferImportResult> {
    this.assertPortableRuntimeAvailable(mapping);
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
    const syntheticPane: TmuxPane = {
      sessionId: "muxpilot",
      sessionName: "muxpilot",
      windowId: "@imported",
      windowIndex: -1,
      windowName: portableName,
      paneId: `%imported-${portable.codexSessionId}`,
      paneIndex: -1,
      paneActive: false,
      cwd: destination,
      currentCommand: "codex",
      title: portableName,
      pid: 0,
      size: "0x0"
    };
    const documentScopeId = portable.workspaceMode === "directory" ? this.requireDocuments().newScopeId() : null;
    const session: ManagedSession = {
      id: placeholderId,
      name: portableName,
      cwd: destination,
      provider: { kind: "codex", threadId: portable.codexSessionId, rolloutPath: transcriptPath },
      driverKind: "codex_tmux",
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
    const restored = await this.restoreSession(placeholderId, mapping.driverKind);
    return {
      codexSessionId: portable.codexSessionId,
      sessionName: portable.sessionName,
      status: keptExisting ? "kept_existing" : "resumed",
      sessionId: restored.session.id,
      error: null
    };
  }

  async validatePortableMapping(portable: PortableSession, mapping: SessionTransferImportMapping): Promise<void> {
    this.assertPortableRuntimeAvailable(mapping);
    const destination = await requireExistingDirectory(mapping.destinationCwd);
    if (portable.workspaceMode !== "git") return;
    if (!this.gitWorkspaces) throw new SessionRestoreError("Managed Git workspaces are unavailable");
    const targetBranch = portable.gitBranchId ? portable.targetBranch : mapping.targetBranch ?? portable.targetBranch;
    if (!targetBranch) throw new SessionRestoreError(`A local target branch is required for '${portable.sessionName}'`);
    const probe = await this.gitWorkspaces.probe(destination);
    if (!probe.isGit || !probe.repoRoot) throw new SessionRestoreError(`Destination for '${portable.sessionName}' is not a Git repository`);
    if (!probe.localBranches.includes(targetBranch)) throw new SessionRestoreError(`Local target branch '${targetBranch}' does not exist for '${portable.sessionName}'`);
  }

  assertPortableRuntimeAvailable(mapping: Pick<SessionTransferImportMapping, "driverKind">): void {
    if (mapping.driverKind === "codex_tmux") this.tmux.requireAvailable();
  }

  async enqueueInput(
    sessionId: string,
    text: string,
    mode?: CollaborationMode,
    actorSessionId: string | null = null
  ): Promise<QueuedInput> {
    const storedSession = await this.db.getSession(sessionId);
    if (storedSession && storedSession.driverKind !== "codex_app_server") this.tmux.requireAvailable();
    const session = requireSession(storedSession);
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
    if (session.driverKind === "codex_app_server") {
      if (session.status !== "approval") return null;
      const message = await this.db.latestApprovalMessage(sessionId);
      const approval = message ? materializeApproval(message) : null;
      return approval ? this.repositoryScopedApproval(sessionId, approval) : null;
    }
    const interactive = await this.captureInteractiveApprovalPrompt(session);
    if (interactive) {
      const context = await this.db.activeApprovalContext(sessionId);
      const contextMessage = matchingInteractiveApprovalContext(
        interactive,
        context.messages
      );
      if (!contextMessage && context.hasContext) {
        this.liveApprovals.delete(sessionId);
        return null;
      }
      const approval = materializeInteractiveApproval(session, interactive, contextMessage);
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
    if (session.driverKind === "codex_app_server" && session.status !== "question") return null;
    const latestQuestionMessage = await this.db.latestQuestionMessage(
      sessionId,
      session.driverKind === "codex_app_server"
    );
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
    delivery: InputDeliveryIntent = "auto"
  ): Promise<{ session: ManagedSession; message: ChatMessage } | { queuedInput: QueuedInput }> {
    const storedSession = await this.db.getSession(sessionId);
    if (storedSession && storedSession.driverKind !== "codex_app_server") this.tmux.requireAvailable();
    const session = requireSession(storedSession);
    if (session.driverKind !== "codex_app_server") {
      return this.sendInputExclusive(sessionId, text, mode, actorSessionId, delivery);
    }
    return this.serializeRuntimeOperation(sessionId, () => this.sendInputExclusive(sessionId, text, mode, actorSessionId, delivery));
  }

  private async sendInputExclusive(
    sessionId: string,
    text: string,
    mode?: CollaborationMode,
    actorSessionId: string | null = null,
    delivery: InputDeliveryIntent = "auto"
  ): Promise<{ session: ManagedSession; message: ChatMessage } | { queuedInput: QueuedInput }> {
    let session = requireSession(await this.db.getSession(sessionId));
    if (session.driverKind === "codex_app_server" && session.runtime?.kind === "systemd_service" && session.runtime.state === "hibernated") {
      session = await this.wakeAppServerSessionExclusive(session);
    }
    if (session.status === "input_failed") {
      throw new InputDeliveryError("Retry or dismiss the failed input before sending another message");
    }
    if (delivery === "steer" && session.driverKind === "codex_app_server") {
      return this.sendSteeredInputExclusive(session, text, actorSessionId);
    }
    if (await this.shouldQueueInput(session, text)) {
      return { queuedInput: await this.enqueueInput(sessionId, text, mode, actorSessionId) };
    }
    const targetMode = mode ?? session.inputMode;
    const now = nowIso();
    let message = await this.recordSubmittedInput(session, text, targetMode, now, null, actorSessionId);
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
    actorSessionId: string | null = null
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
      return { queuedInput: await this.enqueueInput(session.id, text, targetMode, actorSessionId) };
    }
    if (this.deliveringInputSessionIds.has(session.id)) {
      return { queuedInput: await this.enqueueInput(session.id, text, targetMode, actorSessionId) };
    }

    const submittedAt = nowIso();
    let message = await this.recordSubmittedInput(
      session,
      text,
      targetMode,
      submittedAt,
      null,
      actorSessionId,
      "steer"
    );
    this.publish("message.appended", session.id, message);
    this.deliveringInputSessionIds.add(session.id);
    try {
      message = await this.updateInputDelivery(message, { deliveryPhase: "delivering" });
      let receipt: DriverInputReceipt;
      let acknowledgedBy = "app_server_steer_receipt";
      try {
        receipt = await driver.steer(session, text, message.id);
      } catch (error) {
        if (error instanceof AppServerSteerUnavailableError) {
          const queuedInput = await this.enqueueInput(session.id, text, targetMode, actorSessionId);
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

  private async sendRawInput(session: ManagedSession, text: string): Promise<InputTransportResult | void> {
    const pane = await this.livePane(session);
    return this.tmux.sendInput(pane.paneId, codexTerminalUserText(text));
  }

  private async sendSessionNotice(session: ManagedSession, text: string): Promise<void> {
    const driver = this.appServerDriver(session);
    if (driver) {
      await driver.sendMessage(session, text, eventId());
      return;
    }
    await this.sendRawInput(session, text);
  }

  private async recordSubmittedInput(
    session: ManagedSession,
    text: string,
    mode: CollaborationMode,
    timestamp: string,
    queuedInputId: string | null = null,
    actorSessionId: string | null = null,
    deliveryKind: "turn_start" | "steer" = "turn_start"
  ): Promise<ChatMessage> {
    const message: Omit<ChatMessage, "sequence"> = {
      id: eventId(),
      sessionId: session.id,
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
          deliveryPhase: "persisted",
          attemptCount: 1,
          replayCount: 0,
          enterRetryCount: 0,
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
    const storedTarget = await this.db.getSession(targetSessionId);
    if (storedTarget && storedTarget.driverKind !== "codex_app_server") this.tmux.requireAvailable();
    const target = requireSession(storedTarget);
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
      const cwd = actor.gitWorkspace?.entryPath ?? actor.repo.root ?? actor.cwd ?? actor.tmux.cwd;
      const request: CreateSessionRequest = actor.gitWorkspace
        ? { cwd, name, driverKind: actor.driverKind, workspace: { mode: "git", targetBranch: actor.gitWorkspace.targetBranch } }
        : { cwd, name, driverKind: actor.driverKind, workspace: { mode: "directory" } };
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
      if ([...descendants, target].some((session) => session.driverKind !== "codex_app_server")) {
        this.tmux.requireAvailable();
      }
      for (const session of [...descendants, target]) {
        const current = await this.db.getSession(session.id);
        if (!current?.agentOwnership || current.agentOwnership.completedAt) continue;
        if (current.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(current.gitWorkspace.id, "owning agent session was finished");
        if (current.driverKind === "codex_app_server") {
          if (current.runtime?.kind === "systemd_service" && current.runtime.state !== "hibernated" && current.runtime.state !== "stopped") {
            await this.requireAppServerDriver().kill(current);
            await this.db.upsertSession({ ...current, runtime: { ...current.runtime, state: "stopped" } }, nowIso());
          }
        } else {
          const panes = await this.tmux.listPanes();
          const pane = panes.find((candidate) => tmuxPaneSessionId(candidate) === current.id);
          if (pane) await this.tmux.killPane(pane.paneId);
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
    if (storedSession.driverKind === "codex_app_server") {
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
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
    const session = storedSession;
    const ready = await this.readyLiveSession(session);
    if (!ready) return false;
    if (this.deliveringInputSessionIds.has(sessionId) || this.processingQueuedSessionIds.has(sessionId)) return false;
    this.deliveringInputSessionIds.add(sessionId);
    try {
      await this.sendRawInput(ready, message);
      const now = nowIso();
      const status = activeInputStatus(ready.inputMode);
      await this.db.setSessionStatus(sessionId, status, now);
      await this.db.addAudit("muxpilot", "resume_agent_wait", sessionId, "ok", now);
      this.publish("status.changed", sessionId, { status });
      return true;
    } finally {
      this.deliveringInputSessionIds.delete(sessionId);
    }
  }

  private withAgentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.agentMutationQueue.catch(() => undefined).then(operation);
    this.agentMutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async interruptSessionRuntime(session: ManagedSession): Promise<void> {
    const driver = this.appServerDriver(session);
    if (driver) await driver.interrupt(session, null);
    else await this.tmux.interrupt(session.tmux.paneId);
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
    if (this.deliveringInputSessionIds.has(session.id)) {
      throw new InputDeliveryError("Another input delivery is already in progress for this session");
    }
    this.deliveringInputSessionIds.add(session.id);
    let current = message;
    try {
      current = await this.updateInputDelivery(current, { deliveryPhase: "delivering" });
      const appServerDriver = this.appServerDriver(session);
      if (appServerDriver) {
        if (session.inputMode !== mode) {
          await appServerDriver.setPreferences(session, { mode });
          await this.db.setSessionInputMode(session.id, mode, nowIso());
        }
        const receipt = await appServerDriver.sendMessage(
          { ...session, inputMode: mode },
          message.text,
          message.id
        );
        const latest = await this.db.latestUserMessage(session.id);
        if (latest?.id === current.id) current = latest;
        current = await this.updateInputDelivery(current, {
          state: "acknowledged",
          deliveryPhase: "acknowledged",
          acknowledgedBy: "app_server_receipt",
          clientMessageId: receipt.clientMessageId,
          threadId: receipt.threadId,
          turnId: receipt.turnId,
          acceptedAt: receipt.acceptedAt,
          failureReason: null
        });
        await this.db.addAudit("local", "input_delivery_app_server", session.id, JSON.stringify({
          promptHash: inputPromptHash(session.id, message.text),
          promptLength: message.text.length,
          clientMessageId: receipt.clientMessageId,
          threadId: receipt.threadId,
          turnId: receipt.turnId
        }), receipt.acceptedAt);
        return current;
      }
      const liveSession = await this.ensureInputMode(session, mode);
      const result = await this.sendRawInput(liveSession, message.text);
      current = await this.updateInputDelivery(current, {
        deliveryPhase: "awaiting_ack",
        transportPasteRetryCount: result?.pasteReplayCount ?? 0,
        enterRetryCount: result?.submitKeyRetryCount ?? 0,
        failureReason: null
      });
      await this.db.addAudit("local", "input_delivery_transport", session.id, JSON.stringify({
        promptHash: inputPromptHash(session.id, message.text),
        promptLength: message.text.length,
        transportPasteRetryCount: result?.pasteReplayCount ?? 0,
        enterRetryCount: result?.submitKeyRetryCount ?? 0
      }), nowIso());
      return current;
    } catch (error) {
      const reason = error instanceof InputTransportError
        ? error.reason
        : session.driverKind === "codex_app_server" ? "app_server_rejected" : "tmux_failed";
      const failureReason = inputDeliveryFailureMessage(reason);
      current = await this.updateInputDelivery(current, {
        state: "failed",
        deliveryPhase: "failed",
        failureCode: reason,
        transportPasteRetryCount: error instanceof InputTransportError ? error.result.pasteReplayCount : 0,
        enterRetryCount: error instanceof InputTransportError ? error.result.submitKeyRetryCount : 0,
        failureReason
      });
      const failedAt = nowIso();
      await this.db.setSessionStatus(session.id, "input_failed", failedAt);
      await this.db.addAudit("local", "input_delivery_failed", session.id, JSON.stringify({
        promptHash: inputPromptHash(session.id, message.text),
        promptLength: message.text.length,
        reason
      }), failedAt);
      this.publish("message.appended", session.id, current);
      this.publish("status.changed", session.id, { status: "input_failed" });
      this.publish("session.updated", session.id, await this.db.getSession(session.id));
      throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
    } finally {
      this.deliveringInputSessionIds.delete(session.id);
    }
  }

  async resolveApproval(sessionId: string, request: ResolveApprovalRequest): Promise<void> {
    const storedSession = await this.db.getSession(sessionId);
    if (storedSession && storedSession.driverKind !== "codex_app_server") this.tmux.requireAvailable();
    const session = requireSession(storedSession);
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

    if (session.driverKind === "codex_app_server") {
      try {
        await this.appServerDriver(session)?.answerApproval(
          session,
          approval.requestId ?? approval.id,
          codexDecision
        );
      } catch (error) {
        throw new ApprovalResolutionError(
          `Could not submit the approval to Codex app-server: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const now = nowIso();
      if (request.decision === "approve_for_prefix" && approval.prefixRule?.length && workspace) {
        await this.db.addRepositoryApprovalRule(
          workspace.commonGitDir,
          normalizeRepositoryApprovalPrefix(approval.prefixRule, workspace),
          now
        );
      }
      await this.db.setSessionStatus(sessionId, "waiting", now);
      await this.db.addAudit("local", `approval:${request.decision}`, sessionId, "ok", now);
      this.publish("status.changed", sessionId, { status: "waiting" });
      this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
      return;
    }

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
    const storedSession = await this.db.getSession(sessionId);
    if (storedSession && storedSession.driverKind !== "codex_app_server") this.tmux.requireAvailable();
    const session = requireSession(storedSession);
    const question = await this.getPendingQuestion(sessionId);
    if (!question) throw new QuestionResolutionError("No pending question for this session");
    const normalized = normalizeQuestionAnswer(question, request);
    try {
      if (session.driverKind === "codex_app_server") {
        await this.appServerDriver(session)?.answerQuestion(
          session,
          question.requestId ?? question.id,
          normalized
        );
      } else {
        await this.answerInteractiveQuestion(session, question, normalized);
      }
    } catch (error) {
      if (error instanceof QuestionResolutionError) throw error;
      throw new QuestionResolutionError(
        session.driverKind === "codex_app_server"
          ? `Could not submit the answer to Codex app-server: ${error instanceof Error ? error.message : String(error)}`
          : "Could not submit the answer to the active Codex question. The pane may have changed or become unavailable; restore or restart the session and try again."
      );
    }
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
    launchSettings?: { model: string | null; reasoningEffort: string | null; fastMode?: boolean | null },
    driverKind: SessionDriverKind = this.defaultSessionDriver
  ): Promise<ManagedSession> {
    if (driverKind === "codex_tmux") this.tmux.requireAvailable();
    const directory = await requireExistingDirectory(cwd);
    const sessionName = requireSessionName(name);
    if (driverKind === "codex_app_server") this.requireAppServerDriver();
    const preferences = driverKind === "codex_app_server" && launchSettings === undefined
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
    if (driverKind === "codex_app_server") {
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
    const launch = await this.tmux.createCodexWindowInMuxpilotSession(directory, sessionName, prepared.options);
    let session = await this.persistInitializingSession(launch.pane, directory, null, null, undefined, documentScopeId);
    session = await this.bindOrchestratedLaunch(prepared.capabilityId, session.id);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "create_session", session.id, "ok", nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  async createSession(
    request: CreateSessionRequest,
    launchSettings?: { model: string | null; reasoningEffort: string | null; fastMode?: boolean | null }
  ): Promise<ManagedSession> {
    const directory = await requireExistingDirectory(request.cwd);
    const sessionName = requireSessionName(request.name);
    const driverKind = request.driverKind ?? this.defaultSessionDriver;
    if (driverKind === "codex_app_server") this.requireAppServerDriver();
    else this.tmux.requireAvailable();
    const probe = await this.gitWorkspaces?.probe(directory) ?? null;
    if (probe?.isGit && request.workspace?.mode !== "git") {
      throw new CreateSessionError("Target branch is required for new Git sessions", 400);
    }
    if (request.workspace?.mode !== "git") {
      return this.createSessionInDirectory(directory, sessionName, launchSettings, driverKind);
    }
    if (!this.gitWorkspaces) throw new CreateSessionError("Managed Git workspaces are unavailable", 503);

    const workspace = await this.gitWorkspaces.provision({
      sessionName,
      entryPath: directory,
      targetBranch: request.workspace.targetBranch
    });
    const controlPath = await this.gitWorkspaces.ensureControlPath(workspace);
    const preferences = driverKind === "codex_app_server" && launchSettings === undefined
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
    if (driverKind === "codex_app_server") {
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
    const launch = await this.tmux.createCodexWindowInMuxpilotSession(
      controlPath,
      sessionName,
      prepared.options
    );
    const sessionId = tmuxPaneSessionId(launch.pane);
    await this.gitWorkspaces.bind(workspace.id, sessionId);
    let session = await this.persistInitializingSession(launch.pane, workspace.summary.entryPath, workspace.summary, null, undefined, workspace.id);
    session = await this.bindOrchestratedLaunch(prepared.capabilityId, session.id);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "create_git_session", sessionId, workspace.id, nowIso());
    this.publish("session.updated", session.id, session);
    return session;
  }

  async forkSession(sessionId: string, name: string, driverKind?: SessionDriverKind): Promise<ManagedSession> {
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
    const selectedDriver = driverKind ?? source.driverKind ?? "codex_tmux";
    if (selectedDriver === "codex_app_server") {
      this.requireAppServerDriver();
      return this.forkAppServerSession(source, sourceThreadId, sessionNameValue, forkedFrom);
    }
    this.tmux.requireAvailable();

    let launch;
    let orchestrationCapabilityId: string | null = null;
    let gitWorkspace: GitWorkspaceSummary | null = null;
    let documentScopeId: string;
    let repoPath: string;
    if (source.gitWorkspace) {
      if (!this.gitWorkspaces) throw new CreateSessionError("Managed Git workspaces are unavailable", 503);
      const workspace = await this.gitWorkspaces.provision({
        sessionName: sessionNameValue,
        entryPath: source.gitWorkspace.entryPath,
        targetBranch: source.gitWorkspace.targetBranch
      });
      const controlPath = await this.gitWorkspaces.ensureControlPath(workspace);
      documentScopeId = workspace.id;
      await this.requireDocuments().copy(await this.ensureDocumentScope(source), documentScopeId);
      const documentOptions = await this.withDocumentLaunchOptions(
        managedCodexLaunchOptions(workspace, this.codexHome, this.gitWorktreeRoot, this.managedEnvironment),
        documentScopeId
      );
      const prepared = await this.prepareOrchestratedLaunch(
        documentOptions
      );
      launch = await this.tmux.createCodexForkWindowInMuxpilotSession(
        controlPath,
        sessionNameValue,
        sourceThreadId,
        prepared.options
      );
      const forkSessionId = tmuxPaneSessionId(launch.pane);
      orchestrationCapabilityId = prepared.capabilityId;
      await this.gitWorkspaces.bind(workspace.id, forkSessionId);
      gitWorkspace = workspace.summary;
      repoPath = workspace.summary.entryPath;
    } else {
      repoPath = await requireExistingDirectory(source.repo.root ?? source.tmux.cwd);
      documentScopeId = this.requireDocuments().newScopeId();
      await this.requireDocuments().copy(await this.ensureDocumentScope(source), documentScopeId);
      const documentOptions = await this.withDocumentLaunchOptions({ environment: this.managedEnvironment }, documentScopeId);
      const prepared = await this.prepareOrchestratedLaunch(documentOptions);
      launch = await this.tmux.createCodexForkWindowInMuxpilotSession(repoPath, sessionNameValue, sourceThreadId, prepared.options);
      orchestrationCapabilityId = prepared.capabilityId;
    }

    let session = await this.persistInitializingSession(launch.pane, repoPath, gitWorkspace, forkedFrom, source, documentScopeId);
    session = await this.bindOrchestratedLaunch(orchestrationCapabilityId, session.id);
    this.finishSessionInitialization(session.id, launch.ready);
    await this.db.addAudit("local", "fork_session", session.id, source.id, nowIso());
    this.publish("session.updated", session.id, session);
    return session;
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
      repoPath = await requireExistingDirectory(source.cwd ?? source.repo.root ?? source.tmux.cwd);
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
    if (session.driverKind !== "codex_app_server" || session.runtime?.kind !== "systemd_service") {
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
    if (this.appServerHibernationRunning || !this.sessionDrivers?.has("codex_app_server")) return;
    this.appServerHibernationRunning = true;
    try {
      const sessions = (await this.db.listSessions(true))
        .filter((session) =>
          !session.archived &&
          session.driverKind === "codex_app_server" &&
          session.runtime?.kind === "systemd_service" &&
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
    if (session.driverKind !== "codex_app_server" || session.runtime?.kind !== "systemd_service") {
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
      await requireExistingDirectory(session.cwd ?? session.repo.root ?? session.tmux.cwd);
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
      directory = await requireExistingDirectory(session.cwd ?? session.repo.root ?? session.tmux.cwd);
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
        driverKind: "codex_app_server",
        runtime: launch.runtime,
        capabilities: launch.capabilities,
        codexSessionId: launch.provider.threadId,
        codexJsonlPath: rolloutPath,
        resourceUnit: launch.runtime.kind === "systemd_service" ? launch.runtime.unit : current.resourceUnit,
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
      driverKind: "codex_app_server",
      runtime: launch.runtime,
      capabilities: launch.capabilities,
      tmux: appServerCompatibilityPane(launch.sessionId, name, cwd),
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
      gitWorkspace,
      resourceUnit: launch.runtime.kind === "systemd_service" ? launch.runtime.unit : null,
      documentScopeId
    };
    await this.db.upsertSession(session, now);
    const persisted = requireSession(await this.db.setSessionInitializing(session.id, true, now));
    await this.recordTouchedRepository(persisted, now);
    return persisted;
  }

  private requireAppServerDriver(): AgentSessionDriver {
    if (!this.sessionDrivers?.has("codex_app_server")) {
      throw new CreateSessionError("App-server sessions are unavailable", 503);
    }
    return this.sessionDrivers.require("codex_app_server");
  }

  private async persistInitializingSession(
    pane: TmuxPane,
    repoPath: string,
    gitWorkspace: GitWorkspaceSummary | null = null,
    forkedFrom: SessionForkOrigin | null = null,
    preferences?: Pick<ManagedSession, "inputMode" | "models" | "fastMode" | "fastModeAvailable">,
    documentScopeId?: string | null
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
      gitWorkspace,
      documentScopeId: documentScopeId ?? null
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
    const storedSession = await this.db.getSession(sessionId);
    if (action.type === "kill" && storedSession?.status === "missing") {
      const timestamp = nowIso();
      if (storedSession.agentOwnership?.completedAt && !storedSession.archived) {
        await this.db.markSessionArchived(sessionId, true, timestamp);
      }
      const updatedSession = await this.db.getSession(sessionId) ?? storedSession;
      await this.db.addAudit("local", action.type, sessionId, "already_missing", timestamp);
      this.publish("session.updated", sessionId, updatedSession);
      return updatedSession;
    }
    if (storedSession && storedSession.driverKind !== "codex_app_server" && tmuxRuntimeAction(action)) {
      this.tmux.requireAvailable();
    }
    const session = requireSession(storedSession);
    if (action.type === "extendAgentBudget") {
      return this.operatorExtendAgentBudget(sessionId, action.additionalTokens, action.reason);
    }
    if (action.type === "interrupt") {
      if (session.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(session.gitWorkspace.id, "session interrupted by operator");
      const driver = this.appServerDriver(session);
      if (driver) await driver.interrupt(session, null);
      else await this.tmux.interrupt(session.tmux.paneId);
      const now = nowIso();
      await this.db.setSessionStatus(sessionId, "waiting", now);
      this.publish("status.changed", sessionId, { status: "waiting" });
    }
    if (action.type === "hibernate") {
      await this.hibernateAppServerSession(session, false);
    }
    if (action.type === "wake") {
      await this.wakeAppServerSession(session, false);
    }
    if (action.type === "choosePlanAction") {
      const latestPlanMessage = await this.db.latestPlanReadyMessage(sessionId);
      if (!latestPlanMessage) throw new InputModeSwitchError("No pending proposed plan for this session");
      const driver = this.appServerDriver(session);
      let plan: string | null = null;
      if (action.action !== "stay_in_plan") {
        plan = extractLastCompleteProposedPlan(latestPlanMessage.text);
        if (plan === null) throw new InputModeSwitchError("Pending proposed plan is incomplete");
        const changes = await this.requireDocuments().persistApprovedPlan(
          await this.ensureDocumentScope(session),
          latestPlanMessage.sequence,
          plan
        );
        if (changes.created.length > 0 || changes.updated.length > 0) {
          this.publishDocumentsUpdated(sessionId, changes);
        }
      }
      if (driver) {
        await this.performAppServerPlanAction(session, latestPlanMessage, action.action, plan);
      } else {
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
    }
    if (action.type === "rename") {
      const name = requireSessionName(action.name);
      const driver = this.appServerDriver(session);
      if (driver) await driver.rename(session, name);
      else await this.tmux.renameWindow(session.tmux.paneId, name);
      if (driver) {
        const current = requireSession(await this.db.getSession(sessionId));
        await this.db.upsertSession({ ...current, name }, nowIso());
      } else await this.refreshRenamedSession(session);
    }
    if (action.type === "pin") await this.db.setSessionPinned(sessionId, true, nowIso());
    if (action.type === "unpin") await this.db.setSessionPinned(sessionId, false, nowIso());
    if (action.type === "kill") {
      this.readySessionDiscoveryGeneration.delete(sessionId);
      if (session.gitWorkspace) await this.heavyCommandQueue?.cancelWorkspace(session.gitWorkspace.id, "owning session was killed");
      const driver = this.appServerDriver(session);
      if (driver) {
        await driver.kill(session);
        const current = requireSession(await this.db.getSession(sessionId));
        await this.db.upsertSession({
          ...current,
          status: "missing",
          runtime: current.runtime?.kind === "systemd_service"
            ? { ...current.runtime, state: "stopped" }
            : current.runtime
        }, nowIso());
      } else {
        await this.tmux.killPane(session.tmux.paneId);
      }
    }
    if (action.type === "archiveTranscript") {
      this.readySessionDiscoveryGeneration.delete(sessionId);
      await this.db.markSessionArchived(sessionId, true, nowIso());
    }
    if (action.type === "setInputMode") {
      const appServerDriver = this.appServerDriver(session);
      if (appServerDriver) await appServerDriver.setPreferences(session, { mode: action.mode });
      else await this.ensureInputMode(session, action.mode);
      const updatedAt = nowIso();
      const updatedSession = await this.db.setSessionInputMode(sessionId, action.mode, updatedAt);
      await this.db.addAudit(
        "local",
        "set_input_mode",
        sessionId,
        JSON.stringify({
          previousMode: session.inputMode,
          requestedMode: action.mode,
          switchMethod: appServerDriver ? "structured_settings" : "cycle_keys",
          cycleKeys: appServerDriver ? null : this.inputModeCycleKeys,
          resultingMode: updatedSession?.inputMode ?? null
        }),
        updatedAt
      );
    }
    if (action.type === "setModelSettings") {
      await this.setModelSettings(session, action.mode, action.model, action.reasoningEffort);
    }
    if (action.type === "setFastMode") {
      await this.setFastMode(session, action.enabled);
    }
    if (action.type === "setAgentParent") {
      await this.operatorSetAgentParent(sessionId, action.parentSessionId);
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
    if (action.type === "kill" && session.driverKind !== "codex_app_server") await this.discover();
    if (action.type === "kill" && session.agentOwnership?.completedAt) {
      await this.db.markSessionArchived(sessionId, true, nowIso());
    }
    await this.db.addAudit("local", action.type, sessionId, "ok", nowIso());
    const updatedSession = await this.db.getSession(sessionId);
    this.publish("session.updated", sessionId, updatedSession);
    return updatedSession;
  }

  private async reconcileInputDeliveryState(
    sessionId: string,
    pane: TmuxPane,
    message: ChatMessage | null,
    lifecycle: ChatMessage | null,
    inferredStatus: SessionStatus,
    inputMode: CollaborationMode
  ): Promise<ChatMessage | null> {
    if (!message) return null;
    const submission = muxpilotSubmission(message);
    if (!submission || submission.state === "dismissed" || submission.state === "acknowledged") return message;

    const acknowledgingLifecycle = lifecycle && lifecycle.sequence > message.sequence ? lifecycle.text : null;
    const acknowledged = acknowledgingLifecycle !== null || isDeliveryAcknowledgingStatus(inferredStatus);
    if (acknowledged) {
      const updated = await this.updateInputDelivery(message, {
        state: "acknowledged",
        deliveryPhase: "acknowledged",
        acknowledgedBy: acknowledgingLifecycle ?? "active_status",
        failureReason: null
      });
      await this.db.addAudit("local", "input_delivery_acknowledged", sessionId, JSON.stringify({
        promptHash: inputPromptHash(sessionId, message.text),
        source: recordValue(updated.payload.muxpilotSubmission)?.acknowledgedBy ?? "unknown"
      }), nowIso());
      return updated;
    }

    const attemptedAt = typeof submission.lastAttemptAt === "string" ? submission.lastAttemptAt : message.timestamp;
    const attemptedAtMs = Date.parse(attemptedAt);
    if (!Number.isFinite(attemptedAtMs) || Date.now() - attemptedAtMs < INPUT_DELIVERY_ACK_TIMEOUT_MS) return message;
    if (submission.state === "failed") return message;
    if (typeof submission.deliveryPhase !== "string") return this.failInputDelivery(message, "unverified_legacy_submission");
    if (this.deliveringInputSessionIds.has(sessionId)) return message;
    if (!isInputReadyStatus(inferredStatus)) return this.failInputDelivery(message, "no_codex_acknowledgement");

    let capture: string;
    try {
      capture = await this.tmux.capturePane(
        pane.paneId,
        inputVerificationCaptureLines(codexTerminalUserText(message.text), paneWidth(pane)),
        true
      );
    } catch {
      return this.failInputDelivery(message, "tmux_failed");
    }
    const terminalText = codexTerminalUserText(message.text);
    const enterRetryCount = numericSubmissionField(submission, "enterRetryCount");
    if (composerContainsInput(capture, terminalText)) {
      if (enterRetryCount >= 1) return this.failInputDelivery(message, "submit_not_accepted");
      this.deliveringInputSessionIds.add(sessionId);
      try {
        await this.tmux.submitInput(pane.paneId);
        const attemptedAt = nowIso();
        const updated = await this.updateInputDelivery(message, {
          deliveryPhase: "awaiting_ack",
          enterRetryCount: enterRetryCount + 1,
          lastAttemptAt: attemptedAt,
          failureReason: null
        });
        await this.db.addAudit("local", "input_delivery_enter_retry", sessionId, JSON.stringify({
          promptHash: inputPromptHash(sessionId, message.text),
          enterRetryCount: enterRetryCount + 1
        }), attemptedAt);
        return updated;
      } catch {
        return this.failInputDelivery(message, "tmux_failed");
      } finally {
        this.deliveringInputSessionIds.delete(sessionId);
      }
    }

    if (composerHasInput(capture)) return this.failInputDelivery(message, "composer_changed");
    const replayCount = numericSubmissionField(submission, "replayCount");
    if (replayCount >= 1) return this.failInputDelivery(message, "no_codex_acknowledgement");

    const session = await this.db.getSession(sessionId);
    if (!session) return this.failInputDelivery(message, "session_unavailable");
    this.deliveringInputSessionIds.add(sessionId);
    let current = await this.updateInputDelivery(message, {
      deliveryPhase: "replaying",
      replayCount: replayCount + 1,
      attemptCount: numericSubmissionField(submission, "attemptCount") + 1,
      lastAttemptAt: nowIso(),
      failureReason: null
    });
    try {
      const mode = collaborationModeFromMessage(message) ?? inputMode;
      const liveSession = await this.ensureInputMode(session, mode);
      const result = await this.sendRawInput(liveSession, message.text);
      const replayedAt = nowIso();
      current = await this.updateInputDelivery(current, {
        deliveryPhase: "awaiting_ack",
        transportPasteRetryCount: numericSubmissionField(submission, "transportPasteRetryCount") + (result?.pasteReplayCount ?? 0),
        enterRetryCount: enterRetryCount + (result?.submitKeyRetryCount ?? 0),
        lastAttemptAt: replayedAt
      });
      await this.db.addAudit("local", "input_delivery_replayed", sessionId, JSON.stringify({
        promptHash: inputPromptHash(sessionId, message.text),
        replayCount: replayCount + 1
      }), replayedAt);
      return current;
    } catch (error) {
      return this.failInputDelivery(current, error instanceof InputTransportError ? error.reason : "tmux_failed");
    } finally {
      this.deliveringInputSessionIds.delete(sessionId);
    }
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
    if (this.deliveringInputSessionIds.has(session.id)) {
      throw new InputDeliveryError("Another input delivery is already in progress for this session");
    }
    const message = await this.db.latestUserMessage(session.id);
    const submission = message ? muxpilotSubmission(message) : null;
    const retryableDismissedFailure = submission?.state === "dismissed" && submission.deliveryPhase === "failed";
    if (!message || !submission || (submission.state !== "failed" && !retryableDismissedFailure)) {
      throw new InputDeliveryError("There is no failed input delivery to retry");
    }
    const appServerDriver = this.appServerDriver(session);
    if (appServerDriver) {
      await this.retryAppServerInputDelivery(session, message, submission, appServerDriver);
      return;
    }
    const pane = await this.livePane(session);
    const inferred = await inferStatus(pane, session.status, (paneId, lines) => this.tmux.capturePane(paneId, lines, false));
    if (!isInputReadyStatus(inferred)) throw new InputDeliveryError("Codex is not ready to retry this input");

    const attemptedAt = nowIso();
    const attemptCount = typeof submission.attemptCount === "number" ? submission.attemptCount + 1 : 2;
    const mode = collaborationModeFromMessage(message) ?? session.inputMode;
    const terminalText = codexTerminalUserText(message.text);
    let capture: string;
    try {
      capture = await this.tmux.capturePane(
        pane.paneId,
        inputVerificationCaptureLines(terminalText, paneWidth(pane)),
        true
      );
    } catch (error) {
      throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
    }
    if (composerContainsInput(capture, terminalText)) {
      const modeSession = await this.ensureInputMode(session, mode);
      const retryPane = await this.livePane(modeSession);
      let pending = await this.updateInputDelivery(message, {
        state: "pending",
        deliveryPhase: "delivering",
        attemptCount,
        replayCount: 0,
        enterRetryCount: 0,
        lastAttemptAt: attemptedAt,
        failureCode: null,
        failureReason: null
      });
      this.deliveringInputSessionIds.add(session.id);
      try {
        const result = await this.tmux.submitComposedInput(retryPane.paneId, terminalText);
        pending = await this.updateInputDelivery(pending, {
          deliveryPhase: "awaiting_ack",
          enterRetryCount: result.submitKeyRetryCount,
          lastAttemptAt: nowIso()
        });
      } catch (error) {
        const reason = error instanceof InputTransportError ? error.reason : "tmux_failed";
        const failed = await this.updateInputDelivery(pending, {
          state: "failed",
          deliveryPhase: "failed",
          failureCode: reason,
          failureReason: inputDeliveryFailureMessage(reason)
        });
        const failedAt = nowIso();
        await this.db.setSessionStatus(session.id, "input_failed", failedAt);
        await this.db.addAudit("local", "input_delivery_failed", session.id, JSON.stringify({
          promptHash: inputPromptHash(session.id, message.text),
          promptLength: message.text.length,
          reason
        }), failedAt);
        this.publish("message.appended", session.id, failed);
        this.publish("status.changed", session.id, { status: "input_failed" });
        throw new InputDeliveryError(error instanceof Error ? error.message : String(error));
      } finally {
        this.deliveringInputSessionIds.delete(session.id);
      }
      const status = activeInputStatus(mode);
      await this.db.setSessionStatus(session.id, status, attemptedAt);
      await this.db.addAudit("local", "input_delivery_existing_composer_submitted", session.id, JSON.stringify({
        promptHash: inputPromptHash(session.id, message.text),
        enterRetryCount: recordValue(pending.payload.muxpilotSubmission)?.enterRetryCount ?? 0
      }), nowIso());
      this.publish("message.appended", session.id, pending);
      this.publish("status.changed", session.id, { status });
      return;
    }
    if (composerHasInput(capture)) {
      throw new InputDeliveryError("The Codex composer contains different input; it was not overwritten");
    }
    let pending = await this.updateInputDelivery(message, {
      state: "pending",
      deliveryPhase: "persisted",
      attemptCount,
      replayCount: 0,
      enterRetryCount: 0,
      lastAttemptAt: attemptedAt,
      failureCode: null,
      failureReason: null
    });
    pending = await this.deliverSubmittedInput(session, pending, mode);
    const queuedInputId = typeof submission.queuedInputId === "string" ? submission.queuedInputId : null;
    if (queuedInputId) {
      const queued = await this.db.getQueuedInput(session.id, queuedInputId);
      if (queued) {
        const sentAt = nowIso();
        await this.db.updateQueuedInput({ ...queued, status: "sent", error: null, updatedAt: sentAt, sentAt });
        this.publish("queue.updated", session.id, { queuedInputs: await this.db.listQueuedInputs(session.id) });
      }
    }
    const status = activeInputStatus(mode);
    await this.db.setSessionStatus(session.id, status, attemptedAt);
    this.publish("message.appended", session.id, pending);
    this.publish("status.changed", session.id, { status });
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
    if (session.driverKind !== "codex_app_server") return null;
    if (!this.sessionDrivers) throw new Error("App-server session driver registry is unavailable");
    return this.sessionDrivers.require("codex_app_server");
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
    for (const prompt of question.questions) {
      const values = request.answers[prompt.id]?.answers.map((answer) => answer.trim()).filter(Boolean) ?? [];
      const value = values[0];
      if (!value) throw new QuestionResolutionError(`Answer is required for question: ${prompt.id}`);
      const optionIndex = prompt.options.findIndex((option) => option.label === value);
      if (optionIndex >= 0) {
        await this.submitInteractiveQuestionAnswer(pane.paneId, optionIndex, values.slice(1));
        continue;
      }
      if (value === NONE_OF_THE_ABOVE_ANSWER && prompt.options.length > 0) {
        await this.submitInteractiveQuestionAnswer(pane.paneId, prompt.options.length, values.slice(1));
        continue;
      }
      if (prompt.options.length > 0) {
        await this.submitInteractiveQuestionAnswer(pane.paneId, prompt.options.length, values);
        continue;
      }
      await this.tmux.pasteText(pane.paneId, codexTerminalUserText(values.join("\n\n")));
      await this.tmux.sendKeys(pane.paneId, ["Enter"]);
    }
  }

  private async submitInteractiveQuestionAnswer(paneId: string, optionIndex: number, notes: string[]): Promise<void> {
    const note = notes.join("\n\n").trim();
    if (!note) {
      await this.tmux.sendKeys(paneId, menuSelectionKeys(optionIndex));
      return;
    }
    await this.tmux.sendKeys(paneId, [...menuNavigationKeys(optionIndex), "Tab"]);
    await this.tmux.pasteText(paneId, codexTerminalUserText(note));
    await this.tmux.sendKeys(paneId, ["Enter"]);
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

      const readySession = session.driverKind === "codex_app_server"
        ? readyAppServerInputSession(session)
        : await this.readyLiveSession(session);
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
              sending.actorSessionId
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

  private async readyLiveSession(session: ManagedSession): Promise<ManagedSession | null> {
    if (session.initializing) return null;
    let liveSession: ManagedSession;
    try {
      liveSession = await this.liveSession(session);
    } catch {
      return null;
    }

    if (liveSession.initializing) return null;
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

  private async corroboratedLiveApproval(
    pane: TmuxPane,
    contextMessages: ChatMessage[]
  ): Promise<{ prompt: InteractiveApprovalPrompt; contextMessage: ChatMessage } | null> {
    try {
      const prompt = parseInteractiveApprovalPrompt(await this.tmux.capturePane(pane.paneId, 100, false));
      if (!prompt) return null;
      const contextMessage = matchingInteractiveApprovalContext(prompt, contextMessages);
      return contextMessage ? { prompt, contextMessage } : null;
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
    const currentMode = await detectLiveCollaborationMode(
      liveSession.tmux,
      (paneId, lines) => this.tmux.capturePane(paneId, lines, false)
    );
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
    const appServerDriver = this.appServerDriver(session);
    if (appServerDriver) {
      try {
        await appServerDriver.setPreferences(session, { fastMode: enabled });
      } catch (error) {
        throw new FastModeSwitchError(error instanceof Error ? error.message : String(error));
      }
      const updatedAt = nowIso();
      await this.db.setSessionFastMode(session.id, enabled, updatedAt);
      await this.db.addAudit(
        "local",
        "set_fast_mode",
        session.id,
        JSON.stringify({ enabled, method: "structured_settings" }),
        updatedAt
      );
      return;
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
    const terminalText = codexTerminalUserText("/fast");
    try {
      const capture = await this.tmux.capturePane(
        pane.paneId,
        inputVerificationCaptureLines(terminalText, paneWidth(pane)),
        true
      );
      if (composerContainsInput(capture, terminalText)) {
        await this.tmux.submitComposedInput(pane.paneId, terminalText);
      } else if (composerHasInput(capture)) {
        throw new FastModeSwitchError("The Codex composer contains different input; it was not overwritten");
      } else {
        await this.tmux.sendInput(pane.paneId, "/fast");
      }
    } catch (error) {
      if (error instanceof FastModeSwitchError) throw error;
      throw new FastModeSwitchError(error instanceof Error ? error.message : String(error));
    }
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

  private async liveSession(session: ManagedSession): Promise<ManagedSession> {
    const pane = await this.livePane(session);
    return { ...session, tmux: pane };
  }

  private async livePane(session: ManagedSession): Promise<TmuxPane> {
    this.tmux.requireAvailable();
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
      if (session.driverKind === "codex_app_server") {
        if (await this.isLiveAppServerRuntime(session)) return session;
        continue;
      }
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
      if (session.codexSessionId !== codexSessionId) continue;
      if (session.driverKind === "codex_app_server") {
        if (await this.isLiveAppServerRuntime(session)) return session;
        continue;
      }
      if (session.status === "missing") continue;
      try {
        return await this.liveSession(session);
      } catch {
        // Discovery will mark stale rows missing on the next tick.
      }
    }
    return null;
  }

  private async isLiveAppServerRuntime(session: ManagedSession): Promise<boolean> {
    if (session.driverKind !== "codex_app_server" || session.runtime?.kind !== "systemd_service") return false;
    try {
      const evidence = await this.requireAppServerDriver().runtimeEvidence(session);
      return evidence.activeState === "active" && evidence.socketPresent;
    } catch {
      return false;
    }
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
      gitWorkspace: source.gitWorkspace ?? null,
      documentScopeId: source.documentScopeId ?? null
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

  private async shouldIncludePane(
    pane: TmuxPane,
    processInfo: CodexProcessInfo | null,
    existing: ManagedSession | null
  ): Promise<boolean> {
    if (processInfo) return true;
    const sameExistingProcess = Boolean(existing && sameLivePaneProcess(existing, pane));
    if (sameExistingProcess && (existing?.initializing || existing?.startupError)) return true;
    if (isShellCommand(pane.currentCommand)) {
      try {
        const capture = await this.tmux.capturePane(pane.paneId, 80, false);
        return looksLikeCodexScreen(visibleTail(capture));
      } catch {
        return sameExistingProcess;
      }
    }
    if (looksLikeCodexPane(pane)) return true;
    if (!sameExistingProcess && pane.currentCommand !== "node") return false;

    try {
      const capture = await this.tmux.capturePane(pane.paneId, 80, false);
      return looksLikeCodexScreen(visibleTail(capture));
    } catch {
      return sameExistingProcess;
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
  if (reason === "paste_not_observed") return "Codex did not display the pasted input.";
  if (reason === "submit_not_accepted") return "Codex kept the input in the composer after the submit key was retried.";
  if (reason === "composer_changed") return "The Codex composer changed before the input could be safely replayed.";
  if (reason === "unverified_legacy_submission") return "Codex remained ready and did not acknowledge the submitted input.";
  if (reason === "session_unavailable") return "The session became unavailable before the input could be replayed.";
  if (reason === "app_server_rejected") return "Codex app-server did not accept the input.";
  if (reason === "tmux_failed") return "Muxpilot could not deliver the input through tmux.";
  return "Codex remained ready and did not acknowledge the submitted input after one safe replay.";
}

function paneWidth(pane: TmuxPane): number {
  const width = Number.parseInt(pane.size.split("x", 1)[0] ?? "", 10);
  return Number.isFinite(width) && width > 0 ? width : 120;
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
      "Before integration, repeatedly self-review the complete diff, fix every finding, and run focused file/module checks until the review is clean. Do not treat this same-agent self-review as a PR-style review. Run repository-wide scans or test suites only when the user explicitly requests them, or when the user explicitly requests a PR-style review of a branch or ref.",
      "Treat a command as heavyweight if it covers an entire repository, workspace, application, package, or multi-project configuration; performs static-analysis, security, dependency, or container-image scanning such as Semgrep, CodeQL, or Trivy; starts Docker or Docker Compose; launches multiple workers, shards, or projects; produces a production bundle; or is reasonably expected to run longer than one minute, use more than about 1 GiB of memory, or sustain multiple CPU cores. Selected-file lint, syntax-only checks, and one explicitly selected test file or test case without parallel workers are normally not heavyweight. When uncertain, treat the command as heavyweight. Run every heavyweight command through muxpilot-git-run.mjs --heavy -- <command>. The wrapper schedules an already-authorized command; it does not authorize repository-wide validation, and its availability is not a reason to broaden a focused check.",
      "If the heavyweight wrapper reports QUEUED_NOT_RUN, use $muxpilot-heavy-command-queue. The command did not run; do not poll or retry it.",
      "If the heavyweight wrapper reports RUNNING_DEFERRED, use $muxpilot-heavy-command-queue, preserve its run_released event, end the turn immediately, and wait for muxpilot's run_completed continuation. Do not poll or overlap repository work.",
      "User instructions take priority over muxpilot guardrails. A direct invocation names a skill with $skill-name or unambiguous wording such as 'use the review skill'; automatic skill selection is not direct invocation. When a directly invoked skill's instruction body explicitly directs an action that conflicts with a muxpilot guard, treat the invocation itself as operation-scoped authorization for that action even if the skill asks for separate authorization. The skill need not name the guard. Map the action to every affected guard, name each exact guard and consequence, announce that the skill invocation supplies authorization, and proceed without pausing for redundant confirmation. This authorization covers only the named skill's current invocation and its explicitly directed actions; broad capability descriptions, undeclared actions, later operations, and automatically selected skills do not qualify. For every other guard conflict, obtain explicit confirmation for the exact guards before bypassing them. Platform safety, sandbox, permission, and security approval requirements are not muxpilot guards and cannot be bypassed this way.",
      "When a change request creates or selects a local branch for implementation, treat that destination branch as the intended session target even if the user does not explicitly say to change the target; a source ref such as origin/dev is only the start point. If it differs from workflow status, before creating the branch or beginning implementation name the fixed-target guard and explain that current and future task commits will integrate there. Obtain separate explicit confirmation for the fixed-target bypass unless a directly invoked skill explicitly directs that retarget, in which case its invocation supplies operation-scoped authorization. An active worktree must repeat focused checks and self-review after retargeting before integration.",
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
    repoBranch: workspace?.targetBranch ?? session.repo.branch,
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
  return [...menuNavigationKeys(index), "Enter"];
}

function menuNavigationKeys(index: number): string[] {
  return Array.from({ length: index }, () => "Down");
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
  if (lines.some((line) =>
    /^›\s*plan\b/.test(line) ||
    line === "plan mode" ||
    line.startsWith("plan mode prompt:") ||
    (/context \d+% left/.test(line) && line.endsWith("plan mode"))
  )) return "plan";
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

function isShellCommand(command: string): boolean {
  return ["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "pwsh"].includes(command.toLowerCase());
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

function appServerCompatibilityPane(sessionId: string, name: string, cwd: string): TmuxPane {
  const target = `app-server:${sessionId}`;
  return {
    sessionId: target,
    sessionName: name,
    windowId: target,
    windowIndex: -1,
    windowName: name,
    paneId: target,
    paneIndex: -1,
    paneActive: false,
    cwd,
    currentCommand: "codex app-server",
    title: "Codex app-server",
    pid: 0,
    size: "0x0"
  };
}

function appServerLaunchSession(launch: AgentSessionLaunchResult, name: string, cwd: string): ManagedSession {
  return {
    id: launch.sessionId,
    name,
    cwd,
    provider: launch.provider,
    driverKind: "codex_app_server",
    runtime: launch.runtime,
    capabilities: launch.capabilities
  } as ManagedSession;
}

function isRecoverableAppServerSession(session: ManagedSession): boolean {
  return session.driverKind === "codex_app_server"
    && !session.archived
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
  if (session.status === "missing") throw new Error("Session runtime is no longer available");
  return session;
}

function tmuxRuntimeAction(action: SessionAction): boolean {
  return action.type === "interrupt" ||
    action.type === "choosePlanAction" ||
    action.type === "rename" ||
    action.type === "kill" ||
    action.type === "setInputMode" ||
    action.type === "setFastMode" ||
    action.type === "retryInputDelivery" ||
    action.type === "detach";
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
  const toolName = prompt.kind === "permissions" ? permissionToolCallName(prompt, toolCall) : null;
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
    if (prompt.kind === "permissions") return permissionToolCallName(prompt, payload) !== null;
    const name = stringValue(payload.name)?.replace(/^_+/, "");
    if (prompt.kind === "patch") return name === "apply_patch";
    return prompt.kind === "command" && name === "exec_command";
  }
  if (payload.type !== "custom_tool_call" || payload.name !== "exec") return false;
  const input = stringValue(payload.input);
  if (prompt.kind === "permissions") return permissionToolCallName(prompt, payload) !== null;
  if (prompt.kind === "patch") return Boolean(input && /tools\.apply_patch\s*\(/.test(input));
  if (prompt.kind !== "command") return false;
  if (!input || !/tools\.exec_command\s*\(/.test(input)) return false;
  if (/["']?sandbox_permissions["']?\s*:\s*["']require_escalated["']/.test(input)) return true;
  return nestedExecCommandMatchesPrompt(input, prompt);
}

function matchingInteractiveApprovalContext(
  prompt: InteractiveApprovalPrompt,
  contextMessages: ChatMessage[]
): ChatMessage | null {
  return contextMessages.find((message) => {
    if (message.type === "approval_request") {
      const approval = materializeApproval(message);
      if (!approval || approval.kind !== prompt.kind) return false;
      if (!approval.command || !prompt.command) return true;
      return commandMatchesVisibleText(normalizeCommandText(approval.command), prompt.command);
    }
    return interactiveApprovalHasTranscriptContext(prompt, message);
  }) ?? null;
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

interface McpToolCall {
  server: string;
  tool: string;
  name: string;
}

function permissionToolCallName(
  prompt: InteractiveApprovalPrompt,
  payload: Record<string, unknown> | null
): string | null {
  if (!payload) return null;
  const calls = mcpToolCalls(payload);
  const target = mcpPermissionTarget(prompt.title);
  if (target) {
    return calls.find((call) => call.server === target.server && call.tool === target.tool)?.name ?? null;
  }

  const appCall = calls.find((call) => call.server === "codex_apps");
  if (appCall) return appCall.name;
  if (payload.type !== "function_call") return null;
  return functionCallName(payload);
}

function mcpPermissionTarget(title: string): { server: string; tool: string } | null {
  const match = title.match(/^Allow the (.+?) MCP server to run tool ["“]([^"”]+)["”]\?$/i);
  if (!match?.[1] || !match[2]) return null;
  return { server: match[1], tool: match[2] };
}

function mcpToolCalls(payload: Record<string, unknown>): McpToolCall[] {
  if (payload.type === "function_call") {
    const call = functionMcpToolCall(payload);
    return call ? [call] : [];
  }
  if (payload.type !== "custom_tool_call" || payload.name !== "exec") return [];
  const input = stringValue(payload.input);
  if (!input) return [];

  const calls: McpToolCall[] = [];
  for (const match of input.matchAll(/tools\.mcp__([A-Za-z0-9_]+?)__([A-Za-z0-9_]+)\s*\(/g)) {
    if (!match[1] || !match[2]) continue;
    calls.push(mcpToolCall(match[1], match[2]));
  }
  return calls;
}

function functionMcpToolCall(payload: Record<string, unknown>): McpToolCall | null {
  const namespace = stringValue(payload.namespace);
  const tool = stringValue(payload.name)?.replace(/^_+/, "");
  if (!namespace?.startsWith("mcp__") || !tool) return null;
  const qualifiedServer = namespace.slice("mcp__".length);
  if (qualifiedServer.startsWith("codex_apps__")) {
    const app = qualifiedServer.slice("codex_apps__".length);
    return { server: "codex_apps", tool: `${app}_${tool}`, name: `codex_apps.${app}.${tool}` };
  }
  return mcpToolCall(qualifiedServer, tool);
}

function mcpToolCall(server: string, tool: string): McpToolCall {
  if (server === "codex_apps") {
    const separator = tool.indexOf("_");
    if (separator > 0) {
      const app = tool.slice(0, separator);
      const appTool = tool.slice(separator + 1);
      return { server, tool, name: `codex_apps.${app}.${appTool}` };
    }
  }
  return { server, tool, name: `${server}.${tool}` };
}

function functionCallName(payload: Record<string, unknown>): string | null {
  const name = stringValue(payload.name)?.replace(/^_+/, "") ?? null;
  const namespace = stringValue(payload.namespace)?.replace(/__/g, ".") ?? null;
  if (namespace && name) return `${namespace}.${name}`;
  return name ?? namespace;
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
    rawTerminalCapture: false,
    terminalAttach: false,
    hibernate: false
  };
}
