import { open, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  CollaborationMode,
  ManagedSession,
  PlanActionChoice,
  QuestionAnswerRequest,
  QuestionRequest,
  QueuedInput,
  ResolveApprovalRequest,
  SessionAction,
  SessionDirectorySuggestion,
  SessionModelSettings,
  SessionModelSelections,
  SessionStatus,
  TranscriptPageResponse,
  TranscriptSearchResponse,
  TmuxPane
} from "@muxpilot/core";
import { hasCompleteProposedPlan, hasIncompleteProposedPlan, isValidSessionName, normalizeSessionName } from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import { CodexSessionStore, type CodexSessionFile } from "../codex/codexSessionStore.js";
import { PARSER_VERSION, appendSkillNamesForDisplay, parseCodexJsonl } from "../codex/parser.js";
import { TmuxAdapter } from "../tmux/tmuxAdapter.js";
import { eventId, stableId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { loadRepoMetadata } from "./gitMetadata.js";
import type { EventBus } from "./eventBus.js";
import type { CodexProcessInfo } from "../codex/codexProcessResolver.js";
interface ActivitySummaryScheduler {
  schedule(sessionId: string): void;
  stop(): void;
}

interface CodexProcessLookup {
  resolveForPane(panePid: number): Promise<CodexProcessInfo | null>;
}

interface ApprovalKeyMap {
  approveOnce: string[];
  approveForPrefix: string[];
  deny: string[];
}

interface SessionManagerStartOptions {
  runInitialTick?: boolean;
}

interface IngestSessionResult {
  incomplete: boolean;
  progressed: boolean;
}

export class SessionManager {
  private discoveryTimer: NodeJS.Timeout | null = null;
  private parserTimer: NodeJS.Timeout | null = null;
  private discoveryRunning = false;
  private ingestRunning = false;
  private readonly answeredPlanMessageIds = new Set<string>();
  private readonly answeredQuestionMessageIds = new Set<string>();
  private readonly processingQueuedSessionIds = new Set<string>();

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
    private readonly codexProcessLookup: CodexProcessLookup | null = null
  ) {}

  start(options: SessionManagerStartOptions = {}): void {
    if (options.runInitialTick ?? true) {
      void this.runDiscoverTick();
      void this.runIngestTick();
    }
    this.discoveryTimer = setInterval(() => void this.runDiscoverTick(), this.discoveryIntervalMs);
    this.parserTimer = setInterval(() => void this.runIngestTick(), this.parserIntervalMs);
  }

  async reconcileNow(): Promise<void> {
    await this.runDiscoverTick();
    await this.runIngestTick();
  }

  async discoverNow(): Promise<void> {
    await this.runDiscoverTick();
  }

  async catchUpIngest(): Promise<void> {
    if (this.ingestRunning) return;
    this.ingestRunning = true;
    try {
      const sessions = await this.listIngestSessions({ recentFirst: true });
      for (const initialSession of sessions) {
        let session: ManagedSession | null = initialSession;
        while (session) {
          const result = await this.ingestSession(session);
          if (!result.incomplete || !result.progressed) break;
          const refreshed = await this.db.getSession(session.id);
          session =
            refreshed && refreshed.codexJsonlPath === initialSession.codexJsonlPath && !refreshed.archived
              ? refreshed
              : null;
        }
      }
    } finally {
      this.ingestRunning = false;
    }
  }

  stop(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.parserTimer) clearInterval(this.parserTimer);
    this.activitySummarizer?.stop();
  }

  async discover(): Promise<void> {
    const panes = await this.tmux.listPanes();
    const codexFiles = await this.codexStore.listRecent();
    const codexClaims = new Set<string>();
    const now = nowIso();
    const seen = new Set<string>();
    const paneIds = panes.map(tmuxPaneSessionId);

    for (const [index, pane] of panes.entries()) {
      const existingId = paneIds[index] ?? tmuxPaneSessionId(pane);
      const existing = await this.db.getSession(existingId);
      const processInfo = await this.codexProcessLookup?.resolveForPane(pane.pid).catch(() => null) ?? null;
      const match = await claimCodexFile(
        pane,
        existing,
        codexFiles,
        codexClaims,
        processInfo,
        (lines) => this.tmux.capturePane(pane.paneId, lines, false)
      );
      const include = await this.shouldIncludePane(pane, match);
      if (!include) {
        if (match) codexClaims.delete(match.path);
        continue;
      }

      seen.add(existingId);
      const repo = await loadRepoMetadata(pane.cwd);
      const nextCodexSessionId = match?.sessionId ?? null;
      const nextCodexJsonlPath = match?.path ?? null;
      const sourceChanged = Boolean(
        existing &&
          (existing.codexSessionId !== nextCodexSessionId || existing.codexJsonlPath !== nextCodexJsonlPath)
      );
      if (sourceChanged) {
        await this.db.clearSessionTranscript(existingId);
        if (nextCodexJsonlPath) await this.db.resetParserOffset(parserOffsetKey(existingId, nextCodexJsonlPath));
      }
      const inputMode =
        (await detectLiveCollaborationMode(pane, (paneId, lines) => this.tmux.capturePane(paneId, lines, false))) ??
        existing?.inputMode ??
        "default";
      const inferredStatus = await inferStatus(pane, existing?.status, (paneId, lines) => this.tmux.capturePane(paneId, lines, false));
      const latestUserMessage = await this.db.latestUserMessage(existingId);
      const latestQuestionMessage = await this.db.latestQuestionMessage(existingId);
      const status = resolveSessionStatus(
        inferredStatus,
        existing?.status,
        inputMode,
        await this.db.latestMessage(existingId),
        latestQuestionMessage,
        await this.latestQuestionAnswerMessage(existingId, latestQuestionMessage),
        await this.db.latestPlanReadyMessage(existingId),
        await this.db.latestAssistantMessage(existingId),
        latestUserMessage,
        this.answeredPlanMessageIds,
        this.answeredQuestionMessageIds
      );
      const liveModelSettings =
        nextCodexJsonlPath ? await readLatestCodexModelSettings(nextCodexJsonlPath) : null;
      const session: ManagedSession = {
        id: existingId,
        tmux: pane,
        repo,
        codexSessionId: nextCodexSessionId,
        codexJsonlPath: nextCodexJsonlPath,
        discoveryConfidence: match ? "high" : looksLikeCodexPane(pane) ? "medium" : "low",
        status,
        lastActivityAt: sourceChanged ? null : existing?.lastActivityAt ?? null,
        preview: sourceChanged ? "" : existing?.preview ?? "",
        recentUserPrompts: sourceChanged ? [] : existing?.recentUserPrompts ?? [],
        activitySummary: sourceChanged ? null : existing?.activitySummary ?? null,
        activitySummaryGeneratedAt: sourceChanged ? null : existing?.activitySummaryGeneratedAt ?? null,
        activitySummarySourceSequence: sourceChanged ? null : existing?.activitySummarySourceSequence ?? null,
        inputMode,
        models: mergeSessionModels(existing?.models, inputMode, liveModelSettings),
        transcriptSize: sourceChanged ? 0 : existing?.transcriptSize ?? 0,
        unreadCount: sourceChanged ? 0 : existing?.unreadCount ?? 0,
        archived: existing?.archived ?? false
      };

      const changed = !existing || sessionChanged(existing, session);
      await this.db.upsertSession(session, now);
      await this.recordTouchedRepository(session, now);
      if (changed) this.publish("session.updated", session.id, session);
      await this.processQueuedInputs(session.id);
    }

    for (const session of await this.db.listSessions(true)) {
      if (!seen.has(session.id) && session.status !== "missing") {
        await this.db.setSessionStatus(session.id, "missing", now);
        this.publish("status.changed", session.id, { status: "missing" });
      }
    }
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
    for (const session of sessions) {
      await this.ingestSession(session);
    }
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

  private async listIngestSessions(options: { recentFirst?: boolean } = {}): Promise<ManagedSession[]> {
    const sessions = (await this.db.listSessions(true)).filter((session) => session.codexJsonlPath && !session.archived);
    if (!options.recentFirst) return sessions;
    const targets = await Promise.all(
      sessions.map(async (session) => ({
        session,
        sourceUpdatedAtMs: await sessionSourceUpdatedAtMs(session)
      }))
    );
    return targets.sort(compareIngestTargets).map((target) => target.session);
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
        if (await this.db.appendMessage(message)) {
          this.publish("message.appended", session.id, message);
          if (message.role === "user") {
            this.activitySummarizer?.schedule(session.id);
            const messageMode = collaborationModeFromMessage(message);
            if (messageMode) {
              await this.db.setSessionInputMode(session.id, messageMode, nowIso());
              this.publish("session.updated", session.id, await this.db.getSession(session.id));
            }
          }
          if (message.type === "approval_request") {
            const now = nowIso();
            await this.db.setSessionStatus(session.id, "approval", now);
            this.publish("status.changed", session.id, { status: "approval" });
          }
          if (message.type === "question_request") {
            const now = nowIso();
            await this.db.setSessionStatus(session.id, "question", now);
            this.publish("status.changed", session.id, { status: "question" });
          }
          if (isPlanReadyMessage(message)) {
            const now = nowIso();
            await this.db.setSessionStatus(session.id, "plan_ready", now);
            this.publish("status.changed", session.id, { status: "plan_ready" });
          }
        }
      }
      if ((await this.db.deleteEchoedSentQueuedInputs(session.id)) > 0) {
        this.publish("queue.updated", session.id, { queuedInputs: await this.db.listQueuedInputs(session.id) });
      }
      await this.processQueuedInputs(session.id);
      await this.db.setParserOffset(offsetKey, result.nextOffset, PARSER_VERSION, nowIso());
      return { incomplete: !result.complete, progressed: result.nextOffset > offset };
    } catch (error) {
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

  listSessions(includeArchived = false): Promise<ManagedSession[]> {
    return this.db.listSessions(includeArchived);
  }

  getSession(sessionId: string): Promise<ManagedSession | null> {
    return this.db.getSession(sessionId);
  }

  listQueuedInputs(sessionId: string): Promise<QueuedInput[]> {
    return this.db.listQueuedInputs(sessionId);
  }

  async enqueueInput(sessionId: string, text: string, mode?: CollaborationMode): Promise<QueuedInput> {
    const session = requireSession(await this.db.getSession(sessionId));
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
    if (current.status === "sent") throw new QueuedInputError("Queued input has already been sent");
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
    if (!session || session.status !== "approval") return null;
    const message = await this.db.latestApprovalMessage(sessionId);
    if (!message) return null;
    return materializeApproval(message);
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

  async sendInput(sessionId: string, text: string, mode?: CollaborationMode): Promise<void> {
    const session = requireSession(await this.db.getSession(sessionId));
    if (await this.shouldQueueInput(session, text)) {
      await this.enqueueInput(sessionId, text, mode);
      return;
    }
    const targetMode = mode ?? session.inputMode;
    const liveSession = await this.ensureInputMode(session, targetMode);
    await this.sendRawInput(liveSession, text);
    const latestPlanMessage = await this.db.latestPlanReadyMessage(sessionId);
    if (latestPlanMessage && isPlanActionInput(text)) {
      this.answeredPlanMessageIds.add(latestPlanMessage.id);
    }
    const now = nowIso();
    await this.db.setSessionInputMode(sessionId, targetMode, now);
    await this.db.setSessionStatus(sessionId, "waiting", now);
    await this.db.addAudit("local", `send_input:${targetMode}`, sessionId, "ok", now);
    this.publish("status.changed", sessionId, { status: "waiting" });
    this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
  }

  private async shouldQueueInput(session: ManagedSession, text: string): Promise<boolean> {
    if (isPlanActionInput(text)) return false;
    const queuedInputs = await this.db.listQueuedInputs(session.id);
    if (queuedInputs.length > 0) return true;
    return !isInputReadyStatus(session.status);
  }

  private async sendRawInput(session: ManagedSession, text: string): Promise<void> {
    const pane = await this.livePane(session);
    await this.tmux.sendInput(pane.paneId, codexTerminalUserText(text));
  }

  async resolveApproval(sessionId: string, request: ResolveApprovalRequest): Promise<void> {
    const session = requireSession(await this.db.getSession(sessionId));
    const approval = await this.getPendingApproval(sessionId);
    if (!approval) throw new ApprovalResolutionError("No pending approval for this session");
    if (request.decision === "approve_for_prefix" && !approval.prefixRule?.length) {
      throw new ApprovalResolutionError("This approval request does not include a persistent prefix rule");
    }

    const active = await this.isApprovalGateVisible(session);
    if (!active) {
      throw new ApprovalResolutionError("The tmux pane is not showing an approval gate");
    }

    await this.tmux.sendKeys(session.tmux.paneId, this.keysForDecision(request.decision));
    const now = nowIso();
    await this.db.setSessionStatus(sessionId, "waiting", now);
    await this.db.addAudit("local", `approval:${request.decision}`, sessionId, "ok", now);
    this.publish("status.changed", sessionId, { status: "waiting" });
    this.publish("session.updated", sessionId, await this.db.getSession(sessionId));
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

    for (const session of await this.db.listSessions(false)) {
      if (session.status === "missing") continue;
      const candidate = session.repo.root ?? session.tmux.cwd;
      const next = await directorySuggestionFromPath(candidate, "active", session.lastActivityAt, {
        label: session.repo.name,
        repoRoot: session.repo.root,
        branch: session.repo.branch
      });
      if (next) suggestions.set(next.path, mergeDirectorySuggestion(suggestions.get(next.path), next));
    }

    for (const repository of await this.db.listTouchedRepositories()) {
      const next = await directorySuggestionFromPath(repository.path, "recent", repository.lastActivityAt, repository);
      if (next) suggestions.set(next.path, mergeDirectorySuggestion(suggestions.get(next.path), next));
    }

    return [...suggestions.values()].sort(compareDirectorySuggestions);
  }

  async createSessionInDirectory(cwd: string, name: string): Promise<ManagedSession> {
    const directory = await requireExistingDirectory(cwd);
    const sessionName = requireSessionName(name);
    const pane = await this.tmux.createCodexWindowInMuxpilotSession(directory, sessionName);
    await this.discover();

    const sessionId = tmuxPaneSessionId(pane);
    const discovered = await this.db.getSession(sessionId);
    if (discovered) {
      await this.db.addAudit("local", "create_session", discovered.id, "ok", nowIso());
      this.publish("session.updated", discovered.id, discovered);
      return discovered;
    }

    const now = nowIso();
    const repo = await loadRepoMetadata(pane.cwd);
    const session: ManagedSession = {
      id: sessionId,
      tmux: pane,
      repo,
      codexSessionId: null,
      codexJsonlPath: null,
      discoveryConfidence: "medium",
      status: "unknown",
      lastActivityAt: null,
      preview: "",
      recentUserPrompts: [],
      activitySummary: null,
      activitySummaryGeneratedAt: null,
      activitySummarySourceSequence: null,
      inputMode: "default",
      models: emptySessionModels(),
      transcriptSize: 0,
      unreadCount: 0,
      archived: false
    };
    await this.db.upsertSession(session, now);
    await this.recordTouchedRepository(session, now);
    await this.db.addAudit("local", "create_session", session.id, "ok", now);
    this.publish("session.updated", session.id, session);
    return session;
  }

  async act(sessionId: string, action: SessionAction): Promise<ManagedSession | null> {
    const session = requireSession(await this.db.getSession(sessionId));
    if (action.type === "interrupt") await this.tmux.interrupt(session.tmux.paneId);
    if (action.type === "choosePlanAction") {
      const latestPlanMessage = await this.db.latestPlanReadyMessage(sessionId);
      if (!latestPlanMessage) throw new InputModeSwitchError("No pending proposed plan for this session");
      const pane = await this.livePane(session);
      await this.tmux.sendKeys(pane.paneId, keysForPlanAction(action.action));
      this.answeredPlanMessageIds.add(latestPlanMessage.id);
      const now = nowIso();
      await this.db.setSessionInputMode(sessionId, inputModeForPlanAction(action.action), now);
      await this.db.setSessionStatus(sessionId, "waiting", now);
      this.publish("status.changed", sessionId, { status: "waiting" });
    }
    if (action.type === "rename") {
      await this.tmux.renameWindow(session.tmux.paneId, requireSessionName(action.name));
      await this.refreshRenamedSession(session);
    }
    if (action.type === "kill") await this.tmux.killPane(session.tmux.paneId);
    if (action.type === "archiveTranscript") await this.db.markSessionArchived(sessionId, true, nowIso());
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
    if (action.type === "detach") {
      this.publish("notification.created", sessionId, { title: "Detach requested", body: "Detach is managed by tmux clients." });
    }
    if (action.type === "kill") await this.discover();
    await this.db.addAudit("local", action.type, sessionId, "ok", nowIso());
    const updatedSession = await this.db.getSession(sessionId);
    this.publish("session.updated", sessionId, updatedSession);
    return updatedSession;
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
        await this.db.setSessionInputMode(sessionId, sending.mode, now);
        await this.db.setSessionStatus(sessionId, "waiting", now);
        await this.db.addAudit("local", `send_queued_input:${sending.mode}`, sessionId, "ok", now);
        this.publish("status.changed", sessionId, { status: "waiting" });
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
    return this.approvalKeys.deny;
  }

  private async isApprovalGateVisible(session: ManagedSession): Promise<boolean> {
    if (looksLikeApprovalScreen(`${session.tmux.title}\n${session.tmux.windowName}`)) return true;
    try {
      const capture = await this.tmux.capturePane(session.tmux.paneId, 100, false);
      return looksLikeApprovalScreen(capture);
    } catch {
      return false;
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

  private async refreshRenamedSession(session: ManagedSession): Promise<void> {
    const liveSession = await this.liveSession(session);
    const now = nowIso();
    await this.db.upsertSession(liveSession, now);
    await this.recordTouchedRepository(liveSession, now);
  }

  private async recordTouchedRepository(session: ManagedSession, updatedAt: string): Promise<void> {
    const candidate = session.repo.root ?? session.tmux.cwd;
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
    void this.db.appendEvent(event);
    this.events.publish(event);
  }

  private async shouldIncludePane(pane: TmuxPane, match: CodexSessionFile | null): Promise<boolean> {
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

export class ApprovalResolutionError extends Error {
  readonly statusCode = 409;
}

export class QuestionResolutionError extends Error {
  readonly statusCode = 409;
}

export class InputModeSwitchError extends Error {
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
  previousStatus: SessionStatus | undefined,
  inputMode: CollaborationMode,
  latestMessage: ChatMessage | null,
  latestQuestionMessage: ChatMessage | null,
  latestQuestionAnswerMessage: ChatMessage | null,
  latestPlanReadyMessage: ChatMessage | null,
  latestAssistantMessage: ChatMessage | null,
  latestUserMessage: ChatMessage | null,
  answeredPlanMessageIds: Set<string>,
  answeredQuestionMessageIds: Set<string>
): SessionStatus {
  const pendingStatus = preservePendingStatus(
    inferredStatus,
    previousStatus,
    latestMessage,
    latestQuestionMessage,
    latestQuestionAnswerMessage,
    latestPlanReadyMessage,
    latestUserMessage,
    answeredPlanMessageIds,
    answeredQuestionMessageIds
  );
  if (isWorkingStatus(pendingStatus) && isPlanModeTurn(latestUserMessage, inputMode)) return "planning";
  if (
    isInputReadyStatus(pendingStatus) &&
    hasPendingPlanTurn(inputMode, previousStatus, latestAssistantMessage, latestUserMessage, latestPlanReadyMessage)
  ) {
    return "planning";
  }
  return pendingStatus;
}

function requireSessionName(input: string): string {
  const name = normalizeSessionName(input);
  if (!isValidSessionName(name)) throw new SessionNameError("Session name must be 2-32 lowercase letters, numbers, or hyphens");
  return name;
}

function preservePendingStatus(
  inferredStatus: SessionStatus,
  previousStatus: SessionStatus | undefined,
  latestMessage: ChatMessage | null,
  latestQuestionMessage: ChatMessage | null,
  latestQuestionAnswerMessage: ChatMessage | null,
  latestPlanReadyMessage: ChatMessage | null,
  latestUserMessage: ChatMessage | null,
  answeredPlanMessageIds: Set<string>,
  answeredQuestionMessageIds: Set<string>
): SessionStatus {
  if (inferredStatus !== "approval" && previousStatus === "approval" && latestMessage?.type === "approval_request") return "approval";
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

function hasPendingPlanTurn(
  inputMode: CollaborationMode,
  previousStatus: SessionStatus | undefined,
  latestAssistantMessage: ChatMessage | null,
  latestUserMessage: ChatMessage | null,
  latestPlanReadyMessage: ChatMessage | null
): boolean {
  if (!latestUserMessage) return inputMode === "plan" && previousStatus === "planning";
  if (!isPlanModeTurn(latestUserMessage, inputMode)) return false;
  if (latestPlanReadyMessage && latestPlanReadyMessage.sequence > latestUserMessage.sequence) return false;
  if (previousStatus === "planning") return true;
  if (inputMode === "plan") return true;
  if (!latestAssistantMessage || latestAssistantMessage.sequence <= latestUserMessage.sequence) return true;
  if (latestAssistantMessage.type !== "assistant" && latestAssistantMessage.type !== "assistant_update") return false;
  return hasIncompleteProposedPlan(latestAssistantMessage.text);
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
  capturePane: (lines: number) => Promise<string>
): Promise<CodexSessionFile | null> {
  const exact = files.filter((file) => file.cwd === pane.cwd);
  const existingMatch = exact.find((file) => file.path === existing?.codexJsonlPath);
  const compatibleExact = exact.filter((file) => !claims.has(file.path) || file.path === existingMatch?.path);

  const resumedMatch = matchByResumedSessionId(processInfo, compatibleExact);
  if (resumedMatch && !claims.has(resumedMatch.path)) {
    claims.add(resumedMatch.path);
    return resumedMatch;
  }

  const visibleMatch = await visibleCodexFileForPane(compatibleExact, capturePane, existingMatch?.path);
  if (visibleMatch && !claims.has(visibleMatch.path)) {
    claims.add(visibleMatch.path);
    return visibleMatch;
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
        score: await transcriptOverlapScore(file.path, capture)
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

async function transcriptOverlapScore(path: string, capture: string): Promise<number> {
  const visible = normalizeOverlapText(capture);
  if (!visible) return 0;
  const tail = await readFileTail(path, 128 * 1024);
  const chunks = tail
    .split("\n")
    .flatMap((line) => extractJsonlStrings(line))
    .map(normalizeOverlapText)
    .filter((text) => text.length >= 8);

  let score = 0;
  for (const text of chunks) {
    if (visible.includes(text)) score += Math.min(text.length, 400);
  }
  return score;
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

async function readLatestCodexModelSettings(path: string): Promise<SessionModelSettings | null> {
  try {
    return latestCodexModelSettingsFromText(await readFileTail(path, 256 * 1024));
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

function tmuxPaneSessionId(pane: TmuxPane): string {
  return stableId(`${pane.sessionId}:${pane.windowId}:${pane.paneId}`);
}

function sessionChanged(previous: ManagedSession, next: ManagedSession): boolean {
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
    lastActivityAt: session.lastActivityAt,
    inputMode: session.inputMode,
    models: session.models,
    archived: session.archived
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

async function sessionSourceUpdatedAtMs(session: ManagedSession): Promise<number | null> {
  if (!session.codexJsonlPath) return null;
  try {
    return (await stat(session.codexJsonlPath)).mtimeMs;
  } catch {
    return null;
  }
}

function emptySessionModels(): SessionModelSelections {
  return { default: emptySessionModelSettings(), plan: emptySessionModelSettings() };
}

function emptySessionModelSettings(): SessionModelSettings {
  return { model: null, reasoningEffort: null };
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
  const haystack = visibleTail(capture).toLowerCase();
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
  const title = `${pane.title} ${pane.windowName}`.toLowerCase();
  if (title.includes("working") || title.includes("running") || /[\u2800-\u28ff]/u.test(pane.title)) return "working";
  if (looksLikeBlockedStatus(title)) return "blocked";
  if (title.includes("waiting")) return "waiting";
  return null;
}

function inferStatusFromScreen(capture: string): SessionStatus | null {
  const visible = visibleTail(capture);
  const haystack = visible.toLowerCase();
  if (looksLikeApprovalScreen(visible)) return "approval";
  if (haystack.includes("working (") || haystack.includes("esc to interrupt")) return "working";
  if (/(^|\n)\s*›\s/m.test(visible)) return "waiting";
  if (looksLikeBlockedStatus(visible)) return "blocked";
  return null;
}

function visibleTail(text: string): string {
  return text.split("\n").slice(-30).join("\n");
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
    prefixRule: stringArray(approval.prefixRule),
    createdAt: stringValue(approval.createdAt) ?? message.timestamp
  };
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
