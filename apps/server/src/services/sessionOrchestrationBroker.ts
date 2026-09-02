import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDatabase, PersistedAgentWait } from "../db/database.js";
import { liveSessionSubtree, serializeSessionWaitEvent, sessionStatusPresentation, type ManagedSession, type QuestionAnswerRequest } from "@muxpilot/core";
import type { SessionManager } from "./sessionManager.js";
import { nowIso } from "../utils/time.js";
import { isMuxpilotSessionScope } from "./sessionScopes.js";
import { RAW_CODEX_DEFAULT_READ_BYTES, type RawSessionEvidence } from "./rawSessionEvidence.js";
import { agentWorkTokensUsed } from "./agentUsage.js";
import type { CodexMcpServerConfig } from "../tmux/tmuxAdapter.js";
import type { CodexGoalReader, CodexGoalSnapshot, CodexGoalTelemetry } from "../codex/codexGoalStore.js";

const MAX_REQUEST_BYTES = 256 * 1024;
const TERMINAL_OR_ATTENTION = new Set(["idle", "waiting", "question", "approval", "plan_ready", "blocked", "input_failed", "startup_failed", "missing"]);
const MCP_SCRIPT = fileURLToPath(new URL("../../../../scripts/muxpilot-session-mcp.mjs", import.meta.url));

interface Logger {
  info(values: object, message: string): void;
  warn(values: object, message: string): void;
}

interface Capability {
  version: 1;
  id: string;
  token: string;
  socketPath: string;
  actorSessionId: string | null;
}

const UNAVAILABLE_GOAL_READER: CodexGoalReader = {
  read: () => ({ available: false, sampledAt: nowIso(), goals: new Map() })
};

type AgentWait = PersistedAgentWait;

export class SessionOrchestrationBroker {
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly capabilities = new Map<string, Capability>();
  private readonly waits = new Map<string, AgentWait>();
  private ticking = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly manager: SessionManager,
    private readonly socketPath: string,
    private readonly capabilityRoot: string,
    private readonly logger: Logger,
    private readonly rawEvidence: RawSessionEvidence,
    private readonly goalReader: CodexGoalReader = UNAVAILABLE_GOAL_READER
  ) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true });
    await mkdir(this.capabilityRoot, { recursive: true });
    await chmod(this.capabilityRoot, 0o700);
    await rm(this.socketPath, { force: true });
    await this.loadCapabilities();
    for (const wait of await this.db.listAgentWaits()) this.waits.set(wait.actorSessionId, wait);
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
        void this.handle(input.trim()).then(
          (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
          (error) => socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
        );
      });
    });
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, resolveListen);
    });
    await chmod(this.socketPath, 0o600);
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
    this.logger.info({ socketPath: this.socketPath }, "session orchestration broker started");
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.server) await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
    this.server = null;
    await rm(this.socketPath, { force: true });
  }

  async prepareLaunch(): Promise<{ capabilityId: string; server: CodexMcpServerConfig }> {
    const id = randomBytes(12).toString("hex");
    const capability: Capability = { version: 1, id, token: randomBytes(32).toString("hex"), socketPath: this.socketPath, actorSessionId: null };
    this.capabilities.set(capability.token, capability);
    await this.writeCapability(capability);
    return {
      capabilityId: id,
      server: {
        name: "muxpilot_sessions",
        command: process.execPath,
        args: [MCP_SCRIPT, this.capabilityPath(id)],
        defaultToolsApprovalMode: "approve"
      }
    };
  }

  async bindCapability(capabilityId: string, sessionId: string): Promise<void> {
    const capability = [...this.capabilities.values()].find((candidate) => candidate.id === capabilityId);
    if (!capability) throw new Error("Session orchestration capability is missing");
    capability.actorSessionId = sessionId;
    await this.writeCapability(capability);
  }

  private async handle(raw: string): Promise<unknown> {
    const request = JSON.parse(raw) as { version?: unknown; token?: unknown; action?: unknown; args?: unknown };
    if (request.version !== 1 || typeof request.token !== "string" || typeof request.action !== "string") throw new Error("invalid orchestration request");
    const capability = this.capabilities.get(request.token);
    if (!capability?.actorSessionId) throw new Error("unauthorized session capability");
    const actorId = capability.actorSessionId;
    const actor = await this.db.getSession(actorId);
    if (!actor || actor.archived || actor.status === "missing") throw new Error("calling session is unavailable");
    const args = recordValue(request.args) ?? {};
    switch (request.action) {
      case "list_sessions": return this.listSessions(actorId, args.scope === "tree");
      case "read_session": return this.readSession(requiredString(args.sessionId, "sessionId"), boundedInteger(args.limit, 1, 30, 12));
      case "list_tmux_panes": return this.rawEvidence.listTmuxPanes();
      case "capture_tmux_pane": return this.rawEvidence.captureTmuxPane(
        requiredPaneId(args.paneId),
        boundedInteger(args.lines, 1, 2_000, 200),
        args.includeAnsi === true,
        args.joinWrappedLines === true
      );
      case "read_tmux_process_tree": return this.rawEvidence.readTmuxProcessTree(requiredPaneId(args.paneId));
      case "list_codex_session_files": return this.rawEvidence.listCodexSessionFiles(
        boundedInteger(args.limit, 1, 500, 100),
        boundedInteger(args.offset, 0, Number.MAX_SAFE_INTEGER, 0)
      );
      case "read_codex_session_file": return this.rawEvidence.readCodexSessionFile(
        requiredString(args.relativePath, "relativePath"),
        optionalInteger(args.offset, 0, Number.MAX_SAFE_INTEGER),
        boundedInteger(args.length, 1, 256 * 1024, RAW_CODEX_DEFAULT_READ_BYTES)
      );
      case "create_session": return summarizeSession(await this.manager.agentCreateChild(actorId, requiredString(args.name, "name"), requiredString(args.task, "task"), collaborationMode(args.mode)));
      case "claim_session": return summarizeSession(await this.manager.agentClaim(actorId, requiredString(args.sessionId, "sessionId")));
      case "release_session": return summarizeSession(await this.manager.agentRelease(actorId, requiredString(args.sessionId, "sessionId")));
      case "send_message": return summarizeSession(await this.manager.agentSendInput(actorId, requiredString(args.sessionId, "sessionId"), requiredString(args.text, "text"), collaborationMode(args.mode)));
      case "answer_question": {
        const target = requiredString(args.sessionId, "sessionId");
        const answers = recordValue(args.answers);
        if (!answers) throw new Error("answers is required");
        await this.manager.requireAgentControl(actorId, target);
        await this.manager.answerQuestion(target, { answers: answers as QuestionAnswerRequest["answers"] });
        return { ok: true, sessionId: target };
      }
      case "choose_plan_action": {
        const target = requiredString(args.sessionId, "sessionId");
        await this.manager.requireAgentControl(actorId, target);
        await this.manager.act(target, { type: "choosePlanAction", action: planAction(args.action) });
        return { ok: true, sessionId: target };
      }
      case "interrupt_session": {
        const target = requiredString(args.sessionId, "sessionId");
        await this.manager.requireAgentControl(actorId, target);
        await this.manager.act(target, { type: "interrupt" });
        return { ok: true, sessionId: target };
      }
      case "finish_session": {
        const target = requiredString(args.sessionId, "sessionId");
        await this.manager.agentFinish(actorId, target);
        return { ok: true, sessionId: target };
      }
      case "extend_budget": return summarizeSession(await this.manager.agentExtendBudget(actorId, requiredString(args.sessionId, "sessionId"), boundedInteger(args.additionalTokens, 1, 2_000_000), requiredString(args.reason, "reason")));
      case "wait_for_sessions": return this.armWait(actorId, args);
      case "cancel_wait":
        this.waits.delete(actorId);
        await this.db.deleteAgentWait(actorId);
        return { cancelled: true };
      default: throw new Error(`Unknown muxpilot session tool: ${request.action}`);
    }
  }

  private async listSessions(actorId: string, treeOnly: boolean): Promise<unknown> {
    let sessions = await this.manager.listSessions(true, true);
    if (treeOnly) {
      const actor = sessions.find((session) => session.id === actorId)!;
      const root = actor.agentOwnership?.rootSessionId ?? actor.id;
      sessions = sessions.filter((session) => session.id === root || session.agentOwnership?.rootSessionId === root);
    }
    const goalTelemetry = this.goalReader.read(codexThreadIds(sessions));
    return {
      actorSessionId: actorId,
      goalTelemetry: goalTelemetrySummary(goalTelemetry),
      sessions: sessions.map((session) => summarizeSession(session, sessions, goalForSession(session, goalTelemetry)))
    };
  }

  private async readSession(sessionId: string, limit: number): Promise<unknown> {
    const session = await this.manager.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const [page, queuedInputs, sessions] = await Promise.all([
      this.db.listRecentMessages(sessionId, limit),
      this.db.listQueuedInputs(sessionId),
      this.manager.listSessions(true, true)
    ]);
    const goalTelemetry = this.goalReader.read(codexThreadIds([session]));
    let remainingCharacters = 24_000;
    const messages: Array<Record<string, unknown>> = [];
    for (const item of [...page.items].reverse()) {
      if (item.type === "range") {
        messages.unshift({ type: "range", label: item.label, firstSequence: item.firstSequence, lastSequence: item.lastSequence });
        continue;
      }
      if (remainingCharacters <= 0) continue;
      const text = item.message.text.slice(0, Math.min(4_000, remainingCharacters));
      remainingCharacters -= text.length;
      messages.unshift({
        type: item.message.type,
        role: item.message.role,
        sequence: item.message.sequence,
        timestamp: item.message.timestamp,
        delegatedBy: delegatedActorSessionId(item.message.payload),
        payload: item.message.payload,
        text
      });
    }
    return {
      goalTelemetry: goalTelemetrySummary(goalTelemetry),
      session: summarizeSession(session, sessions, goalForSession(session, goalTelemetry)),
      muxpilotRecord: session,
      messages,
      queuedInputs,
      hasMoreBefore: page.hasMoreBefore
    };
  }

  private async armWait(actorSessionId: string, args: Record<string, unknown>): Promise<unknown> {
    if (!Array.isArray(args.sessionIds) || args.sessionIds.length < 1 || args.sessionIds.length > 2 || !args.sessionIds.every((id) => typeof id === "string")) {
      throw new Error("sessionIds must contain one or two exact session ids");
    }
    const sessions = await this.db.listSessions(true);
    for (const id of args.sessionIds) if (!sessions.some((session) => session.id === id)) throw new Error(`Session not found: ${id}`);
    const timeoutMinutes = boundedInteger(args.timeoutMinutes, 1, 1440, 60);
    const wait: AgentWait = {
      actorSessionId,
      sessionIds: [...new Set(args.sessionIds)],
      mode: args.mode === "all" ? "all" : "any",
      expiresAt: Date.now() + timeoutMinutes * 60_000,
      readyAt: null
    };
    this.waits.set(actorSessionId, wait);
    await this.db.upsertAgentWait(wait, nowIso());
    return { armed: true, sessionIds: args.sessionIds, mode: args.mode === "all" ? "all" : "any", timeoutMinutes, instruction: "End this turn immediately. Muxpilot will resume it once the wait condition is satisfied; do not poll." };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const persistedWaits = await this.db.listAgentWaits();
      const persistedActorIds = new Set(persistedWaits.map((wait) => wait.actorSessionId));
      for (const actorId of this.waits.keys()) if (!persistedActorIds.has(actorId)) this.waits.delete(actorId);
      for (const wait of persistedWaits) this.waits.set(wait.actorSessionId, wait);
      const sessions = await this.db.listSessions(true);
      for (const wait of this.waits.values()) {
        const targets = wait.sessionIds.flatMap((id) => {
          const session = sessions.find((candidate) => candidate.id === id);
          return session ? [session] : [];
        });
        const conditions = await Promise.all(targets.map(async (session) => {
          const subtree = liveSessionSubtree(session, sessions);
          if ((await Promise.all(subtree.map((candidate) => this.manager.hasActiveHeavyCommand(candidate.id)))).some(Boolean)) return false;
          const effective = sessionStatusPresentation(session, sessions);
          if (effective.status === "completed") return true;
          if (!TERMINAL_OR_ATTENTION.has(effective.status)) return false;
          if (effective.status !== "idle" && effective.status !== "waiting") return true;
          const queued = (await Promise.all(subtree.map((candidate) => this.db.listQueuedInputs(candidate.id)))).flat();
          return !queued.some((input) => input.status === "queued" || input.status === "sending");
        }));
        const satisfied = Date.now() >= wait.expiresAt || (wait.mode === "all" ? conditions.length === wait.sessionIds.length && conditions.every(Boolean) : conditions.some(Boolean));
        if (!satisfied) continue;
        if (wait.readyAt === null) {
          wait.readyAt = Date.now();
          await this.db.upsertAgentWait(wait, nowIso());
        }
        const snapshot = targets.map((session) => summarizeSession(session, sessions));
        const event = serializeSessionWaitEvent({ version: 1, kind: Date.now() >= wait.expiresAt ? "timeout" : "resume_requested", sessions: snapshot });
        if (await this.manager.resumeAgentWait(wait.actorSessionId, event)) {
          this.waits.delete(wait.actorSessionId);
          await this.db.deleteAgentWait(wait.actorSessionId);
        } else if (Date.now() - wait.readyAt > 10 * 60_000) {
          this.waits.delete(wait.actorSessionId);
          await this.db.deleteAgentWait(wait.actorSessionId);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, "session orchestration wait tick failed");
    } finally { this.ticking = false; }
  }

  private capabilityPath(id: string): string { return join(this.capabilityRoot, `${id}.json`); }

  private async writeCapability(capability: Capability): Promise<void> {
    const path = this.capabilityPath(capability.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(capability)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async loadCapabilities(): Promise<void> {
    for (const name of await readdir(this.capabilityRoot).catch(() => [])) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      try {
        const capability = JSON.parse(await readFile(join(this.capabilityRoot, name), "utf8")) as Capability;
        if (capability.version === 1 && capability.socketPath === this.socketPath && capability.token && capability.id) this.capabilities.set(capability.token, capability);
      } catch { /* Ignore partial or stale capabilities. */ }
    }
  }
}

function summarizeSession(session: ManagedSession, allSessions: ManagedSession[] = [session], goal: CodexGoalSnapshot | null = null) {
  const ownership = session.agentOwnership;
  const usage = session.contextUsage;
  const used = ownership ? agentWorkTokensUsed(ownership, usage) : null;
  const effective = sessionStatusPresentation(session, allSessions);
  return {
    id: session.id,
    name: session.tmux.windowName,
    status: session.status,
    effectiveStatus: effective.status,
    effectiveStatusSessionId: effective.sourceSessionId,
    completedAt: ownership?.completedAt ?? null,
    initializing: session.initializing === true,
    parentSessionId: ownership?.parentSessionId ?? null,
    rootSessionId: ownership?.rootSessionId ?? session.id,
    ownershipOrigin: ownership?.origin ?? null,
    liveDescendantCount: session.agentSummary?.liveDescendantCount ?? 0,
    context: usage ? { activeTokens: usage.activeTokens, windowTokens: usage.contextWindowTokens, percent: Math.round(usage.contextPercent * 10) / 10 } : null,
    lifetimeTokens: usage ? { total: usage.lifetimeTotalTokens, work: usage.lifetimeWorkTokens, cachedInput: usage.lifetimeCachedInputTokens } : null,
    budget: ownership ? { used, limit: ownership.workTokenBudget, remaining: Math.max(0, ownership.workTokenBudget - (used ?? 0)) } : null,
    goal,
    lastActivityAt: session.lastActivityAt,
    preview: session.preview.slice(0, 500),
    orchestrationAvailable: session.orchestrationAvailable === true,
    resourceIsolation: {
      isolated: isMuxpilotSessionScope(session.resourceScope),
      scope: isMuxpilotSessionScope(session.resourceScope) ? session.resourceScope : null
    }
  };
}

function codexThreadIds(sessions: ManagedSession[]): string[] {
  return sessions.flatMap((session) => session.codexSessionId ? [session.codexSessionId] : []);
}

function goalForSession(session: ManagedSession, telemetry: CodexGoalTelemetry): CodexGoalSnapshot | null {
  return session.codexSessionId ? telemetry.goals.get(session.codexSessionId) ?? null : null;
}

function goalTelemetrySummary(telemetry: CodexGoalTelemetry) {
  return { available: telemetry.available, sampledAt: telemetry.sampledAt };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function delegatedActorSessionId(payload: Record<string, unknown>): string | null {
  const submission = recordValue(payload.muxpilotSubmission);
  const actor = recordValue(submission?.actor);
  return actor?.kind === "session" && typeof actor.sessionId === "string" ? actor.sessionId : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredPaneId(value: unknown): string {
  const paneId = requiredString(value, "paneId");
  if (!/^%\d+$/.test(paneId)) throw new Error("paneId must be an exact tmux pane id");
  return paneId;
}

function boundedInteger(value: unknown, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return Number(value);
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (value === undefined) return null;
  return boundedInteger(value, min, max);
}

function collaborationMode(value: unknown): "default" | "plan" | undefined {
  if (value === undefined) return undefined;
  if (value === "default" || value === "plan") return value;
  throw new Error("mode must be default or plan");
}

function planAction(value: unknown): "implement" | "clear_context_implement" | "stay_in_plan" {
  if (value === "implement" || value === "clear_context_implement" || value === "stay_in_plan") return value;
  throw new Error("Invalid plan action");
}
