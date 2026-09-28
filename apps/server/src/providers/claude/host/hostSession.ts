import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyTaskToolResult, TASK_LIST_TOOLS, taskStateList, toolResultText, type ClaudeTaskState, type ClaudeToolUse } from "../messages.js";
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  approvalPermissionUpdates,
  decidePermission,
  DISALLOWED_TOOLS,
  MUXPILOT_MCP_TOOL_PREFIX
} from "./permissionPolicy.js";
import {
  claudeProjectSlug,
  HOST_ERROR,
  HOST_NOTIFICATION,
  type HostAgent,
  type HostApprovalMode,
  type HostApprovalParams,
  type HostApprovalResponse,
  type HostBackgroundTask,
  type HostInputPart,
  type HostInterruptOutcome,
  type HostLaunchConfig,
  type HostPendingRequest,
  type HostPermissionMode,
  type HostQuestionParams,
  type HostQuestionResponse,
  type HostSchedules,
  type HostSessionState,
  type HostThreadStatus,
  type HostTurn,
  type SessionOpenParams,
  type SettingsUpdateParams,
  type TurnReceipt,
  type TurnStartParams,
  type TurnSteerParams
} from "./protocol.js";

export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export class HostOperationError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export interface HostSessionOptions {
  queryFactory: QueryFactory;
  notify(method: string, params: unknown): void;
  configDir: string;
  environment: Record<string, string | undefined>;
  persistState?(state: PersistedHostState): Promise<void>;
  now?(): Date;
  log?(message: string, detail?: unknown): void;
}

/** State written to the host state directory so a restarted host can report how the last turn ended. */
export interface PersistedHostState {
  sessionId: string;
  cwd: string;
  launch: HostLaunchConfig;
  activeTurn: HostTurn | null;
  latestTurn: HostTurn | null;
  inputs: Array<{ clientMessageId: string; messageUuid: string; turnId: string }>;
  agents?: HostAgent[];
}

interface ActiveTurnState {
  turn: HostTurn;
  inputs: Set<string>;
  completedInputs: Set<string>;
  interruptRequested: boolean;
  planProposed: boolean;
  resultSeen: SDKMessage | null;
  rateLimited: boolean;
  authenticationError: string | null;
  /** Started by Claude Code itself (for example after a background task finishes), not by muxpilot input. */
  autonomous?: boolean;
}

interface PendingRequestEntry extends HostPendingRequest {
  resolve(response: unknown): void;
  toolName: string;
  input: Record<string, unknown>;
}

const MAX_REMEMBERED_INPUTS = 500;
const MAX_REMEMBERED_TOOL_USES = 2_000;
const MAX_REMEMBERED_AGENTS = 200;
const PLAN_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const PLAN_FILE_ATTEMPTS = 15;
const PLAN_FILE_RETRY_MS = 200;
const STREAM_NOTIFICATION_INTERVAL_MS = 750;
/** A wakeup is considered fired once an autonomous turn starts near its due time; stale ones expire. */
const WAKEUP_GRACE_MS = 5 * 60_000;
const WAITING_FLAGS: Record<HostPendingRequest["method"], "waitingOnApproval" | "waitingOnUserInput"> = {
  "claude/approval": "waitingOnApproval",
  "claude/question": "waitingOnUserInput"
};

/** One Claude conversation driven through a long-lived streaming SDK query. */
export class HostSession {
  private query: Query | null = null;
  private input: InputQueue | null = null;
  private pumpDone: Promise<void> | null = null;
  private sessionIdValue: string | null = null;
  private cwd = "";
  private launch: HostLaunchConfig | null = null;
  private active: ActiveTurnState | null = null;
  private latestTurn: HostTurn | null = null;
  private readonly pending = new Map<string, PendingRequestEntry>();
  private readonly inputs = new Map<string, { messageUuid: string; turnId: string }>();
  private readonly agents = new Map<string, HostAgent>();
  /** Tool calls by id, so tool results can be classified without re-reading the transcript. */
  private readonly toolUses = new Map<string, { name: string; input: unknown }>();
  private readonly tasks: ClaudeTaskState = new Map();
  private permissionMode: "default" | "plan" = "default";
  private approvalMode: HostApprovalMode = "ask";
  private effectiveMode: HostPermissionMode = "acceptEdits";
  private autoUnavailable = false;
  private wakeupDueAt: number | null = null;
  private readonly cronJobs = new Set<string>();
  private model: string | null = null;
  private effort: string | null = null;
  private fastMode: boolean | null = null;
  private readonly now: () => Date;
  private lastStreamNotificationMs = 0;

  constructor(private readonly options: HostSessionOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  /** Restores durable state after a host restart; an unfinished turn is reported as interrupted. */
  restorePersisted(state: PersistedHostState): void {
    this.sessionIdValue = state.sessionId;
    this.cwd = state.cwd;
    this.launch = state.launch;
    this.permissionMode = state.launch.permissionMode;
    this.approvalMode = state.launch.approvalMode ?? "ask";
    this.model = state.launch.model;
    this.effort = state.launch.effort;
    this.fastMode = state.launch.fastMode;
    this.latestTurn = state.activeTurn
      ? { ...state.activeTurn, status: "interrupted" }
      : state.latestTurn;
    for (const input of state.inputs) this.inputs.set(input.clientMessageId, { messageUuid: input.messageUuid, turnId: input.turnId });
    // Tasks die with the Claude process that ran them.
    for (const agent of state.agents ?? []) {
      this.agents.set(agent.taskId, agent.status === "running" || agent.status === "paused" ? { ...agent, status: "stopped" } : agent);
    }
  }

  isOpen(): boolean {
    return this.query !== null;
  }

  state(): HostSessionState | null {
    if (!this.sessionIdValue) return null;
    return {
      sessionId: this.sessionIdValue,
      cwd: this.cwd,
      transcriptPath: this.transcriptPath(),
      status: this.threadStatus(),
      activeTurn: this.active ? { ...this.active.turn } : null,
      latestTurn: this.latestTurn ? { ...this.latestTurn } : null,
      pendingRequests: [...this.pending.values()].map(({ requestId, method, params, openedAt }) => ({ requestId, method, params, openedAt })),
      backgroundTasks: this.listTasks(),
      agents: this.listAgents(),
      permissionMode: this.permissionMode,
      effectivePermissionMode: this.effectiveMode,
      approvalMode: this.approvalMode,
      autoUnavailable: this.autoUnavailable,
      schedules: this.schedules(),
      model: this.model,
      effort: this.effort,
      fastMode: this.fastMode
    };
  }

  /** Re-announces every unanswered request, e.g. after muxpilot reconnects. */
  replayPendingRequests(): void {
    for (const request of this.pending.values()) {
      this.options.notify(HOST_NOTIFICATION.requestOpened, {
        requestId: request.requestId,
        method: request.method,
        params: request.params,
        openedAt: request.openedAt
      });
    }
  }

  async open(params: SessionOpenParams): Promise<HostSessionState> {
    if (this.query && !params.replace) {
      const current = this.state();
      const expected = params.mode === "resume" ? params.sourceSessionId : params.sessionId;
      if (current && current.sessionId === expected) return current;
      throw new HostOperationError(HOST_ERROR.invalidParams, `Host already owns session ${current?.sessionId ?? "unknown"}`);
    }
    if (params.replace && this.active) {
      throw new HostOperationError(HOST_ERROR.turnActive, "Cannot replace the session while a turn is active");
    }
    if (params.inheritLaunch && this.launch) {
      params = {
        ...params,
        launch: {
          ...this.launch,
          model: params.launch.model,
          effort: params.launch.effort,
          fastMode: params.launch.fastMode,
          permissionMode: params.launch.permissionMode,
          approvalMode: params.launch.approvalMode ?? this.launch.approvalMode
        }
      };
    }
    await this.closeQuery();
    const sessionId = params.mode === "resume" ? requireString(params.sourceSessionId, "sourceSessionId") : params.sessionId;
    this.sessionIdValue = sessionId;
    this.cwd = params.cwd;
    this.launch = params.launch;
    this.permissionMode = params.launch.permissionMode;
    this.approvalMode = params.launch.approvalMode ?? "ask";
    this.model = params.launch.model;
    this.effort = params.launch.effort;
    this.fastMode = params.launch.fastMode;
    this.latestTurn = params.replace ? null : this.latestTurn;
    this.startQuery(params);
    await this.applyEffectiveMode();
    await this.persist();
    return this.state()!;
  }

  async startTurn(params: TurnStartParams): Promise<TurnReceipt> {
    const input = this.requireInput();
    if (this.active) throw new HostOperationError(HOST_ERROR.turnActive, "A Claude turn is already active");
    const known = this.inputs.get(params.clientMessageId);
    if (known) return { turnId: known.turnId, messageUuid: known.messageUuid };
    await this.applyTurnSettings(params);
    const turnId = params.messageUuid;
    this.active = {
      turn: { id: turnId, status: "inProgress" },
      inputs: new Set([params.messageUuid]),
      completedInputs: new Set(),
      interruptRequested: false,
      planProposed: false,
      resultSeen: null,
      rateLimited: false,
      authenticationError: null
    };
    this.rememberInput(params.clientMessageId, params.messageUuid, turnId);
    input.push(await this.userMessage(params.messageUuid, params.content));
    this.notifyInputAccepted(params.clientMessageId, params.messageUuid, turnId, params.content);
    this.options.notify(HOST_NOTIFICATION.turnStarted, {
      threadId: this.sessionIdValue,
      turn: { id: turnId, status: "inProgress" },
      clientMessageId: params.clientMessageId,
      messageUuid: params.messageUuid
    });
    this.notifyStatus();
    await this.persist();
    return { turnId, messageUuid: params.messageUuid };
  }

  async steerTurn(params: TurnSteerParams): Promise<TurnReceipt> {
    const input = this.requireInput();
    const active = this.active;
    if (!active || active.turn.id !== params.expectedTurnId || active.interruptRequested) {
      throw new HostOperationError(HOST_ERROR.noActiveTurn, "Claude has no active turn to steer");
    }
    const known = this.inputs.get(params.clientMessageId);
    if (known) return { turnId: known.turnId, messageUuid: known.messageUuid };
    active.inputs.add(params.messageUuid);
    this.rememberInput(params.clientMessageId, params.messageUuid, active.turn.id);
    // "next" joins the running turn at the next model boundary without aborting in-flight output.
    input.push({ ...await this.userMessage(params.messageUuid, params.content), priority: "next" });
    this.notifyInputAccepted(params.clientMessageId, params.messageUuid, active.turn.id, params.content);
    await this.persist();
    return { turnId: active.turn.id, messageUuid: params.messageUuid };
  }

  async interrupt(turnId: string | null): Promise<HostInterruptOutcome> {
    const active = this.active;
    if (!active || (turnId && active.turn.id !== turnId)) return "already_idle";
    active.interruptRequested = true;
    for (const request of [...this.pending.values()]) {
      this.resolveRequest(request.requestId, request.method === "claude/question" ? { cancelled: true } : { behavior: "deny", message: "The turn was interrupted." }, "interrupted");
    }
    await this.query?.interrupt().catch((error) => this.options.log?.("interrupt failed", error));
    return "interrupted";
  }

  lookupInput(clientMessageId: string): TurnReceipt | null {
    const known = this.inputs.get(clientMessageId);
    return known ? { turnId: known.turnId, messageUuid: known.messageUuid } : null;
  }

  respond(requestId: string, response: unknown): boolean {
    return this.resolveRequest(requestId, response, "answered");
  }

  async updateSettings(params: SettingsUpdateParams): Promise<void> {
    const query = this.requireQuery();
    if (params.permissionMode) this.permissionMode = params.permissionMode;
    if (params.approvalMode) this.approvalMode = params.approvalMode;
    await this.applyEffectiveMode();
    if (params.model !== undefined && params.model !== this.model) {
      await query.setModel(params.model ?? undefined);
      this.model = params.model;
    }
    const flags: Record<string, unknown> = {};
    if (params.effort !== undefined && params.effort !== this.effort) flags.effortLevel = params.effort;
    if (params.fastMode !== undefined && params.fastMode !== this.fastMode) flags.fastMode = params.fastMode;
    if (Object.keys(flags).length > 0) {
      await query.applyFlagSettings(flags as never);
      if ("effortLevel" in flags) this.effort = params.effort ?? null;
      if ("fastMode" in flags) this.fastMode = params.fastMode ?? null;
    }
    if (this.launch) {
      this.launch = {
        ...this.launch,
        permissionMode: this.permissionMode,
        approvalMode: this.approvalMode,
        model: this.model,
        effort: this.effort,
        fastMode: this.fastMode
      };
      await this.persist();
    }
  }

  async stopTask(taskId: string): Promise<void> {
    await this.requireQuery().stopTask(taskId);
  }

  /** Running, non-ambient tasks: the work that keeps the runtime from hibernating. */
  listTasks(): HostBackgroundTask[] {
    return [...this.agents.values()]
      .filter((agent) => (agent.status === "running" || agent.status === "paused") && !agent.ambient)
      .map((agent) => ({ taskId: agent.taskId, toolUseId: agent.toolUseId, turnId: null, description: agent.description }));
  }

  listAgents(): HostAgent[] {
    return [...this.agents.values()].map((agent) => ({ ...agent }));
  }

  async contextUsage(): Promise<unknown> {
    return this.requireQuery().getContextUsage();
  }

  async close(): Promise<void> {
    for (const request of [...this.pending.values()]) {
      this.resolveRequest(request.requestId, request.method === "claude/question" ? { cancelled: true } : { behavior: "deny", message: "The session is shutting down." }, "shutdown");
    }
    await this.closeQuery();
  }

  hasActiveTurn(): boolean {
    return this.active !== null;
  }

  private startQuery(params: SessionOpenParams): void {
    const launch = params.launch;
    const input = new InputQueue();
    const writableRoots = [...new Set([params.cwd, ...launch.writableRoots])];
    // Native auto is switched on after the query starts, so an account without it never fails the launch.
    this.effectiveMode = effectivePermissionMode(launch.permissionMode, "ask", false);
    const options: Options = {
      cwd: params.cwd,
      pathToClaudeCodeExecutable: launch.claudePath,
      env: { ...this.options.environment, CLAUDE_CONFIG_DIR: this.options.configDir },
      model: launch.model ?? undefined,
      effort: (launch.effort ?? undefined) as Options["effort"],
      permissionMode: this.effectiveMode,
      settingSources: launch.settingSources,
      includePartialMessages: true,
      // One-line summaries for the Agents view, the same ones the Claude Code CLI shows in its task panel.
      agentProgressSummaries: true,
      thinking: { type: "adaptive", display: "summarized" },
      additionalDirectories: launch.writableRoots,
      disallowedTools: [...DISALLOWED_TOOLS],
      allowedTools: [`${MUXPILOT_MCP_TOOL_PREFIX}*`],
      mcpServers: Object.fromEntries(launch.mcpServers.map((server): [string, McpServerConfig] => [
        server.name,
        { type: "stdio", command: server.command, args: server.args }
      ])),
      plugins: launch.pluginDirs.map((path) => ({ type: "local" as const, path })),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(launch.systemPromptAppend ? { append: launch.systemPromptAppend } : {}),
        // muxpilot re-sends current instructions on every launch; never replay a stale recorded prompt.
        snapshot: false
      },
      settings: {
        permissions: { disableBypassPermissionsMode: "disable" },
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
          filesystem: { allowWrite: writableRoots },
          network: {
            allowedDomains: ["*"],
            allowLocalBinding: true,
            allowUnixSockets: launch.allowUnixSockets
          }
        }
      } as Options["settings"],
      canUseTool: this.canUseTool,
      stderr: (data) => this.options.log?.("claude stderr", data.slice(0, 2_000)),
      ...(params.mode === "start"
        ? { sessionId: params.sessionId }
        : params.mode === "resume"
          ? { resume: params.sourceSessionId }
          : { resume: params.sourceSessionId, forkSession: true, sessionId: params.sessionId })
    };
    const query = this.options.queryFactory({ prompt: input, options });
    this.input = input;
    this.query = query;
    this.pumpDone = this.pump(query);
  }

  private async closeQuery(): Promise<void> {
    const query = this.query;
    const input = this.input;
    this.query = null;
    this.input = null;
    input?.close();
    query?.close();
    await this.pumpDone?.catch(() => undefined);
    this.pumpDone = null;
  }

  private async pump(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.query !== query) break;
        this.handleMessage(message);
      }
    } catch (error) {
      if (this.query !== query) return;
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.("claude query failed", message);
      this.options.notify(HOST_NOTIFICATION.hostError, { threadId: this.sessionIdValue, message });
      if (isAuthenticationText(message)) this.options.notify(HOST_NOTIFICATION.authFailed, { threadId: this.sessionIdValue, message });
      this.finishActiveTurn("failed", message);
    } finally {
      if (this.query === query) {
        this.query = null;
        this.input = null;
        this.finishActiveTurn("failed", "The Claude runtime stopped unexpectedly.");
      }
    }
  }

  private handleMessage(message: SDKMessage): void {
    // Subagents keep streaming after the parent turn ends; only main-thread output starts an autonomous turn.
    if (!this.active && (message.type === "assistant" || message.type === "stream_event") && message.parent_tool_use_id === null) {
      this.beginAutonomousTurn(message.uuid);
    }
    const turnId = this.active?.turn.id ?? null;
    if (message.type === "result") {
      this.options.notify(HOST_NOTIFICATION.sdkMessage, { threadId: this.sessionIdValue, turnId, message });
      this.observeResult(message);
      return;
    }
    if (message.type === "stream_event") {
      // Token deltas only signal liveness; complete messages carry the content, so coalesce them.
      const nowMs = this.now().getTime();
      if (nowMs - this.lastStreamNotificationMs < STREAM_NOTIFICATION_INTERVAL_MS) return;
      this.lastStreamNotificationMs = nowMs;
      this.options.notify(HOST_NOTIFICATION.sdkMessage, {
        threadId: this.sessionIdValue,
        turnId,
        message: { type: "stream_event", uuid: message.uuid },
        transient: true
      });
      return;
    }
    const record = message as unknown as Record<string, unknown>;
    if (record.type === "command_lifecycle") {
      const state = record.state;
      const commandUuid = typeof record.command_uuid === "string" ? record.command_uuid : null;
      if (this.active && commandUuid && (state === "completed" || state === "cancelled")) {
        this.active.completedInputs.add(commandUuid);
        this.maybeCompleteTurn();
      }
      return;
    }
    if (message.type === "system") {
      if (message.subtype === "status" && message.permissionMode) this.observePermissionMode(message.permissionMode);
      if (message.subtype.startsWith("task_")) this.observeTask(message);
    }
    if (message.type === "assistant") this.rememberToolUses(message);
    if (message.type === "user") {
      this.observeSchedules(message);
      this.options.notify(HOST_NOTIFICATION.sdkMessage, {
        threadId: this.sessionIdValue,
        turnId,
        message,
        toolUses: this.toolUsesFor(message)
      });
      return;
    }
    if (message.type === "assistant" && this.active) {
      if (message.error === "rate_limit") this.active.rateLimited = true;
      if (message.error === "authentication_failed") {
        this.active.authenticationError = assistantText(message) || "Claude authentication failed.";
        this.options.notify(HOST_NOTIFICATION.authFailed, { threadId: this.sessionIdValue, message: this.active.authenticationError });
      }
    }
    if (message.type === "auth_status" && message.error) {
      this.options.notify(HOST_NOTIFICATION.authFailed, { threadId: this.sessionIdValue, message: message.error });
    }
    if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected" && this.active) {
      this.active.rateLimited = true;
    }
    this.options.notify(HOST_NOTIFICATION.sdkMessage, { threadId: this.sessionIdValue, turnId, message });
  }

  /**
   * Claude Code wakes itself for some events (a background task finishing re-prompts the model). Model output
   * with no muxpilot turn open becomes an autonomous turn so the session shows as working until its result.
   */
  private beginAutonomousTurn(uuid: string | undefined): void {
    if (this.active || !this.sessionIdValue) return;
    const turnId = `auto-${uuid ?? randomUUID()}`;
    if (this.wakeupDueAt !== null && this.wakeupDueAt <= this.now().getTime() + WAKEUP_GRACE_MS) this.wakeupDueAt = null;
    this.active = {
      turn: { id: turnId, status: "inProgress" },
      inputs: new Set(),
      completedInputs: new Set(),
      interruptRequested: false,
      planProposed: false,
      resultSeen: null,
      rateLimited: false,
      authenticationError: null,
      autonomous: true
    };
    this.options.notify(HOST_NOTIFICATION.turnStarted, {
      threadId: this.sessionIdValue,
      turn: { id: turnId, status: "inProgress" },
      clientMessageId: null,
      messageUuid: null
    });
    this.notifyStatus();
    void this.persist();
  }

  private observeResult(message: Extract<SDKMessage, { type: "result" }>): void {
    const active = this.active;
    if (!active) return;
    const uuids = [message.user_message_uuid, ...(message.user_message_uuids ?? [])].filter((value): value is string => typeof value === "string");
    // A result without submission identity closes a streaming segment aborted by queued input, not the turn.
    if (uuids.length === 0 && !active.interruptRequested && !active.autonomous) return;
    for (const uuid of uuids) active.completedInputs.add(uuid);
    active.resultSeen = message;
    this.maybeCompleteTurn();
  }

  private maybeCompleteTurn(): void {
    const active = this.active;
    if (!active?.resultSeen) return;
    if (!active.interruptRequested && [...active.inputs].some((uuid) => !active.completedInputs.has(uuid))) return;
    const result = active.resultSeen as Extract<SDKMessage, { type: "result" }>;
    if (active.interruptRequested || isAbortedResult(result)) {
      this.finishActiveTurn("interrupted", null);
      return;
    }
    if (result.subtype === "success" && !result.is_error) {
      this.finishActiveTurn("completed", null);
      return;
    }
    const errors = "errors" in result ? result.errors : [];
    const detail = (result.subtype === "success" ? result.result : errors.join("; ")) || `Claude turn failed (${result.subtype})`;
    const code = active.authenticationError
      ? "authenticationFailed"
      : active.rateLimited ? "usageLimitExceeded" : result.subtype;
    this.finishActiveTurn("failed", active.authenticationError ?? detail, code);
  }

  private finishActiveTurn(status: Exclude<HostTurn["status"], "inProgress">, errorMessage: string | null, code: string | null = null): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    for (const request of [...this.pending.values()]) {
      if ((request.params as { turnId?: string }).turnId === active.turn.id) {
        this.resolveRequest(request.requestId, request.method === "claude/question" ? { cancelled: true } : { behavior: "deny", message: "The turn ended." }, "turn_ended");
      }
    }
    const turn: HostTurn = {
      id: active.turn.id,
      status,
      ...(status === "failed" ? { error: { message: errorMessage ?? "Claude turn failed", codexErrorInfo: code } } : {}),
      ...(status === "completed" && active.planProposed ? { items: [{ type: "plan" }] } : {})
    };
    this.latestTurn = turn;
    this.options.notify(HOST_NOTIFICATION.turnCompleted, {
      threadId: this.sessionIdValue,
      turn,
      result: active.resultSeen
    });
    this.notifyStatus();
    void this.persist();
  }

  private readonly canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    const decision = decidePermission(toolName, toolInput, options as never, {
      cwd: this.cwd,
      writableRoots: this.launch?.writableRoots ?? []
    });
    const turnId = this.active?.turn.id ?? "";
    const threadId = this.sessionIdValue ?? "";
    if (decision.kind === "allow") return { behavior: "allow", updatedInput: toolInput };
    if (decision.kind === "deny") return { behavior: "deny", message: decision.message };
    if (decision.kind === "plan") {
      const plan = await this.proposedPlanText(toolInput);
      if (this.active) this.active.planProposed = true;
      this.options.notify(HOST_NOTIFICATION.planProposed, { threadId, turnId, itemId: options.toolUseID, plan });
      return {
        behavior: "deny",
        message: "muxpilot recorded this plan for operator review. End your turn now without further tool calls."
      };
    }
    if (decision.kind === "question") {
      const params = questionParams(threadId, turnId, options.toolUseID, toolInput);
      const response = await this.openRequest("claude/question", params, toolName, toolInput, options.signal) as HostQuestionResponse;
      if ("cancelled" in response) return { behavior: "deny", message: "The operator dismissed the question." };
      return { behavior: "allow", updatedInput: { ...toolInput, answers: questionAnswers(params, response) } };
    }
    const params: HostApprovalParams = {
      threadId,
      turnId,
      itemId: options.toolUseID,
      toolName,
      category: decision.category,
      title: decision.title,
      command: decision.command,
      cwd: this.cwd,
      reason: decision.reason,
      prefixRule: decision.prefixRule,
      agentId: options.agentID ?? null,
      agentLabel: options.agentID ? this.agents.get(options.agentID)?.description ?? null : null,
      input: toolInput
    };
    const response = await this.openRequest("claude/approval", params, toolName, toolInput, options.signal) as HostApprovalResponse;
    if (response.behavior === "deny") {
      return { behavior: "deny", message: response.message ?? "The operator denied this action." } satisfies PermissionResult;
    }
    return {
      behavior: "allow",
      updatedInput: toolInput,
      updatedPermissions: approvalPermissionUpdates(toolName, toolInput, response, decision.prefixRule) as never
    } satisfies PermissionResult;
  };

  /**
   * Current Claude Code writes the plan to a file under its plans directory and calls ExitPlanMode with no input;
   * older versions pass the plan inline. Read the plan file Claude most recently wrote when the input is empty.
   */
  private async proposedPlanText(input: Record<string, unknown>): Promise<string> {
    if (typeof input.plan === "string" && input.plan.trim()) return input.plan;
    const planFile = [...this.toolUses.values()].reverse().find((use) => {
      const path = (use.input as { file_path?: unknown } | null)?.file_path;
      return PLAN_WRITE_TOOLS.has(use.name) && typeof path === "string" && /[\\/]plans[\\/][^\\/]+\.md$/.test(path);
    });
    const path = (planFile?.input as { file_path?: string } | undefined)?.file_path;
    if (!path) return "";
    // Claude may send the plan-file Write and ExitPlanMode together, so the file can land a moment later.
    for (let attempt = 0; attempt < PLAN_FILE_ATTEMPTS; attempt += 1) {
      const text = await readFile(path, "utf8").catch(() => "");
      if (text.trim()) return text;
      await new Promise((resolve) => setTimeout(resolve, PLAN_FILE_RETRY_MS));
    }
    this.options.log?.("plan file unreadable", path);
    return "";
  }

  /** Folds Claude Code's task lifecycle events into the agent list the Agents view shows. */
  private observeTask(message: Extract<SDKMessage, { type: "system" }>): void {
    const event = message as unknown as Record<string, unknown>;
    const taskId = typeof event.task_id === "string" ? event.task_id : null;
    if (!taskId) return;
    const nowIso = this.now().toISOString();
    const current = this.agents.get(taskId);
    const usage = taskUsage(event.usage) ?? current?.usage ?? null;
    let next: HostAgent | null = null;
    if (event.subtype === "task_started") {
      next = {
        taskId,
        toolUseId: stringField(event.tool_use_id),
        taskType: stringField(event.task_type),
        subagentType: stringField(event.subagent_type),
        description: stringField(event.description) ?? stringField(event.workflow_name) ?? "Task",
        status: "running",
        backgrounded: event.is_backgrounded === true,
        depth: typeof event.spawn_depth === "number" ? event.spawn_depth : null,
        lastToolName: null,
        summary: null,
        error: null,
        usage: null,
        ambient: event.ambient === true || event.skip_transcript === true,
        startedAt: nowIso,
        updatedAt: nowIso
      };
    } else if (current && event.subtype === "task_progress") {
      next = {
        ...current,
        usage,
        lastToolName: stringField(event.last_tool_name) ?? current.lastToolName,
        summary: stringField(event.summary) ?? current.summary,
        updatedAt: nowIso
      };
    } else if (current && event.subtype === "task_updated") {
      const patch = (event.patch ?? {}) as Record<string, unknown>;
      next = {
        ...current,
        status: taskStatus(patch.status) ?? current.status,
        description: stringField(patch.description) ?? current.description,
        backgrounded: typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : current.backgrounded,
        error: stringField(patch.error) ?? current.error,
        updatedAt: nowIso
      };
    } else if (event.subtype === "task_notification") {
      const base: HostAgent = current ?? {
        taskId,
        toolUseId: stringField(event.tool_use_id),
        taskType: null,
        subagentType: null,
        description: "Task",
        status: "running",
        backgrounded: true,
        depth: null,
        lastToolName: null,
        summary: null,
        error: null,
        usage: null,
        ambient: event.ambient === true,
        startedAt: nowIso,
        updatedAt: nowIso
      };
      next = { ...base, status: taskStatus(event.status) ?? "completed", summary: stringField(event.summary) ?? base.summary, usage, updatedAt: nowIso };
    }
    if (!next) return;
    this.agents.delete(taskId);
    this.agents.set(taskId, next);
    while (this.agents.size > MAX_REMEMBERED_AGENTS) {
      const oldest = this.agents.keys().next().value;
      if (oldest === undefined) break;
      this.agents.delete(oldest);
    }
    this.options.notify(HOST_NOTIFICATION.agentsChanged, { threadId: this.sessionIdValue, agents: this.listAgents() });
    if (event.subtype !== "task_progress") void this.persist();
  }

  /**
   * muxpilot's (mode, approval) pair decides Claude's permission mode: Plan is plan, Normal is acceptEdits, and
   * Normal with Auto approval uses Claude's own auto classifier when the account supports it.
   */
  private async applyEffectiveMode(): Promise<void> {
    const query = this.query;
    if (!query) return;
    const desired = effectivePermissionMode(this.permissionMode, this.approvalMode, this.autoUnavailable);
    if (desired === this.effectiveMode) return;
    try {
      await query.setPermissionMode(desired);
      this.effectiveMode = desired;
    } catch (error) {
      if (desired !== "auto") throw error;
      this.options.log?.("native auto mode unavailable", error instanceof Error ? error.message : String(error));
      this.autoUnavailable = true;
      const fallback = effectivePermissionMode(this.permissionMode, this.approvalMode, true);
      if (fallback !== this.effectiveMode) await query.setPermissionMode(fallback);
      this.effectiveMode = fallback;
      this.notifyModeChanged();
    }
  }

  /** Claude switched modes itself (EnterPlanMode, or leaving plan); mirror it into muxpilot's mode. */
  private observePermissionMode(mode: string): void {
    if (mode === this.effectiveMode) return;
    this.effectiveMode = mode as HostPermissionMode;
    const collaboration = mode === "plan" ? "plan" : "default";
    if (collaboration === this.permissionMode) return;
    this.permissionMode = collaboration;
    if (this.launch) this.launch = { ...this.launch, permissionMode: collaboration };
    this.notifyModeChanged();
    void this.persist();
  }

  private notifyModeChanged(): void {
    this.options.notify(HOST_NOTIFICATION.modeChanged, {
      threadId: this.sessionIdValue,
      mode: this.permissionMode,
      effectivePermissionMode: this.effectiveMode,
      autoUnavailable: this.autoUnavailable
    });
  }

  /** Tracks ScheduleWakeup and Cron results; pending schedules keep the runtime from hibernating. */
  private observeSchedules(message: Extract<SDKMessage, { type: "user" }>): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    const structured = (message as { tool_use_result?: unknown }).tool_use_result;
    for (const block of content) {
      if (block.type !== "tool_result" || block.is_error === true) continue;
      const known = this.toolUses.get(block.tool_use_id);
      if (!known) continue;
      const input = (known.input ?? {}) as Record<string, unknown>;
      if (known.name === "ScheduleWakeup") {
        const delay = typeof input.delaySeconds === "number" ? Math.min(3_600, Math.max(60, input.delaySeconds)) : null;
        this.wakeupDueAt = input.stop === true || delay === null ? null : this.now().getTime() + delay * 1_000;
      } else if (known.name === "CronCreate") {
        const id = structuredId(structured) ?? /\b(?:id|ID)[:\s]+([A-Za-z0-9_-]+)/.exec(toolResultText(block.content))?.[1];
        if (id) this.cronJobs.add(id);
      } else if (known.name === "CronDelete" && typeof input.id === "string") {
        this.cronJobs.delete(input.id);
      }
    }
  }

  private schedules(): HostSchedules {
    if (this.wakeupDueAt !== null && this.wakeupDueAt < this.now().getTime() - WAKEUP_GRACE_MS) this.wakeupDueAt = null;
    return {
      wakeupDueAt: this.wakeupDueAt === null ? null : new Date(this.wakeupDueAt).toISOString(),
      cronJobIds: [...this.cronJobs]
    };
  }

  private openRequest(
    method: HostPendingRequest["method"],
    params: HostApprovalParams | HostQuestionParams,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    const requestId = `req:${params.itemId}`;
    return new Promise((resolve) => {
      const entry: PendingRequestEntry = {
        requestId,
        method,
        params,
        openedAt: this.now().toISOString(),
        toolName,
        input,
        resolve
      };
      this.pending.set(requestId, entry);
      signal.addEventListener("abort", () => {
        this.resolveRequest(requestId, method === "claude/question" ? { cancelled: true } : { behavior: "deny", message: "The request was cancelled." }, "cancelled");
      }, { once: true });
      this.options.notify(HOST_NOTIFICATION.requestOpened, { requestId, method, params, openedAt: entry.openedAt });
      this.notifyStatus();
    });
  }

  private resolveRequest(requestId: string, response: unknown, resolution: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(response);
    this.options.notify(HOST_NOTIFICATION.requestResolved, {
      threadId: this.sessionIdValue,
      requestId,
      resolution
    });
    this.notifyStatus();
    return true;
  }

  private threadStatus(): HostThreadStatus {
    if (!this.active) return { type: this.query ? "idle" : "notLoaded" };
    const flags = [...new Set([...this.pending.values()].map((request) => WAITING_FLAGS[request.method]))];
    return { type: "active", activeFlags: flags };
  }

  private notifyStatus(): void {
    if (!this.sessionIdValue) return;
    this.options.notify(HOST_NOTIFICATION.threadStatus, { threadId: this.sessionIdValue, status: this.threadStatus() });
  }

  private async applyTurnSettings(params: TurnStartParams): Promise<void> {
    await this.updateSettings({
      permissionMode: params.mode,
      ...(params.approvalMode ? { approvalMode: params.approvalMode } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.fastMode !== null && params.fastMode !== this.fastMode ? { fastMode: params.fastMode } : {})
    });
  }

  private async userMessage(uuid: string, content: HostInputPart[]): Promise<SDKUserMessage> {
    const blocks = await Promise.all(content.map(async (part) => {
      if (part.type === "text") return { type: "text" as const, text: part.value };
      const data = await readFile(part.value);
      return {
        type: "image" as const,
        source: { type: "base64" as const, media_type: imageMediaType(part), data: data.toString("base64") }
      };
    }));
    return {
      type: "user",
      uuid: uuid as SDKUserMessage["uuid"],
      parent_tool_use_id: null,
      message: { role: "user", content: blocks }
    };
  }

  private notifyInputAccepted(clientMessageId: string, messageUuid: string, turnId: string, content: HostInputPart[]): void {
    this.options.notify(HOST_NOTIFICATION.inputAccepted, {
      threadId: this.sessionIdValue,
      turnId,
      clientMessageId,
      messageUuid,
      text: content.flatMap((part) => part.type === "text" ? [part.value] : []).join(""),
      acceptedAt: this.now().toISOString()
    });
  }

  private rememberToolUses(message: Extract<SDKMessage, { type: "assistant" }>): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      this.toolUses.set(block.id, { name: block.name, input: block.input });
      while (this.toolUses.size > MAX_REMEMBERED_TOOL_USES) {
        const oldest = this.toolUses.keys().next().value;
        if (oldest === undefined) break;
        this.toolUses.delete(oldest);
      }
    }
  }

  private toolUsesFor(message: SDKMessage): Record<string, ClaudeToolUse> {
    const content = message.type === "user" ? message.message.content : null;
    if (!Array.isArray(content)) return {};
    const result: Record<string, ClaudeToolUse> = {};
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const known = this.toolUses.get(block.tool_use_id);
      if (!known) continue;
      if (TASK_LIST_TOOLS.has(known.name) && block.is_error !== true) {
        applyTaskToolResult(this.tasks, known.name, known.input, toolResultText(block.content));
        result[block.tool_use_id] = { ...known, taskList: taskStateList(this.tasks) };
      } else {
        result[block.tool_use_id] = known;
      }
    }
    return result;
  }

  private rememberInput(clientMessageId: string, messageUuid: string, turnId: string): void {
    this.inputs.set(clientMessageId, { messageUuid, turnId });
    while (this.inputs.size > MAX_REMEMBERED_INPUTS) {
      const oldest = this.inputs.keys().next().value;
      if (oldest === undefined) break;
      this.inputs.delete(oldest);
    }
  }

  private transcriptPath(): string | null {
    if (!this.sessionIdValue || !this.cwd) return null;
    return join(this.options.configDir, "projects", claudeProjectSlug(this.cwd), `${this.sessionIdValue}.jsonl`);
  }

  private async persist(): Promise<void> {
    if (!this.options.persistState || !this.sessionIdValue || !this.launch) return;
    await this.options.persistState({
      sessionId: this.sessionIdValue,
      cwd: this.cwd,
      launch: this.launch,
      activeTurn: this.active ? { ...this.active.turn } : null,
      latestTurn: this.latestTurn,
      inputs: [...this.inputs].map(([clientMessageId, value]) => ({ clientMessageId, ...value })),
      agents: this.listAgents()
    }).catch((error) => this.options.log?.("persist state failed", error));
  }

  private requireQuery(): Query {
    if (!this.query) throw new HostOperationError(HOST_ERROR.notOpen, "The Claude session is not open");
    return this.query;
  }

  private requireInput(): InputQueue {
    this.requireQuery();
    if (!this.input) throw new HostOperationError(HOST_ERROR.notOpen, "The Claude session is not open");
    return this.input;
  }
}

/** Push-based async iterable feeding user messages into the SDK query. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Claude input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

function questionParams(threadId: string, turnId: string, itemId: string, input: Record<string, unknown>): HostQuestionParams {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return {
    threadId,
    turnId,
    itemId,
    questions: questions.map((value, index) => {
      const question = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const options = Array.isArray(question.options) ? question.options : [];
      return {
        id: `q${index}`,
        header: typeof question.header === "string" ? question.header : "",
        question: typeof question.question === "string" ? question.question : "",
        options: options.map((option) => {
          const record = option && typeof option === "object" ? option as Record<string, unknown> : {};
          return {
            label: typeof record.label === "string" ? record.label : "",
            description: typeof record.description === "string" ? record.description : ""
          };
        }),
        multiSelect: question.multiSelect === true
      };
    })
  };
}

/** AskUserQuestion answers are keyed by question text; multi-select answers are comma-separated. */
function questionAnswers(params: HostQuestionParams, response: Extract<HostQuestionResponse, { answers: unknown }>): Record<string, string> {
  return Object.fromEntries(params.questions.map((question) => [
    question.question,
    (response.answers[question.id]?.answers ?? []).join(", ")
  ]));
}

function isAbortedResult(result: Extract<SDKMessage, { type: "result" }>): boolean {
  const reason = (result as { terminal_reason?: unknown }).terminal_reason;
  return typeof reason === "string" && reason.startsWith("aborted");
}

function assistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  const content = message.message.content;
  return Array.isArray(content)
    ? content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim()
    : "";
}

function isAuthenticationText(text: string): boolean {
  return /\/login|not logged in|authentication|oauth token|invalid api key|unauthori[sz]ed/i.test(text);
}

function imageMediaType(part: HostInputPart): "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
  if (part.mimeType === "image/jpeg" || part.mimeType === "image/webp" || part.mimeType === "image/gif") return part.mimeType;
  if (/\.jpe?g$/i.test(part.value)) return "image/jpeg";
  if (/\.webp$/i.test(part.value)) return "image/webp";
  return "image/png";
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new HostOperationError(HOST_ERROR.invalidParams, `${name} is required`);
  return value;
}

export function effectivePermissionMode(
  mode: "default" | "plan",
  approvalMode: HostApprovalMode,
  autoUnavailable: boolean
): HostPermissionMode {
  if (mode === "plan") return "plan";
  return approvalMode === "auto" && !autoUnavailable ? "auto" : "acceptEdits";
}

function structuredId(value: unknown): string | null {
  const id = value && typeof value === "object" ? (value as Record<string, unknown>).id : null;
  return typeof id === "string" && id ? id : null;
}

function taskStatus(value: unknown): HostAgent["status"] | null {
  if (value === "running" || value === "pending") return "running";
  if (value === "paused") return "paused";
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "stopped" || value === "killed") return "stopped";
  return null;
}

function taskUsage(value: unknown): HostAgent["usage"] {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const number = (field: unknown) => typeof field === "number" && Number.isFinite(field) ? field : 0;
  return { totalTokens: number(usage.total_tokens), toolUses: number(usage.tool_uses), durationMs: number(usage.duration_ms) };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
