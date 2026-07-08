import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  CodexSkillsResponse,
  CreateSessionRequest,
  QuestionAnswerRequest,
  ResolveApprovalRequest,
  SendInputRequest,
  SessionAction,
  UpdateActivitySummarySettingsRequest
} from "@muxpilot/core";
import {
  ApprovalResolutionError,
  CreateSessionError,
  InputModeSwitchError,
  QuestionResolutionError,
  QueuedInputError,
  type SessionManager
} from "../services/sessionManager.js";
import type { EventBus } from "../services/eventBus.js";
import type { AppDatabase } from "../db/database.js";
import type { AppConfig } from "../config/config.js";
import type { AccessControl } from "../auth/auth.js";
import { buildConnectivity, buildRemoteAccess } from "../services/connectivity.js";
import { discoverCodexSkills } from "../services/skillDiscovery.js";
import type { CodexUsageService } from "../services/codexUsage.js";
import type { ActivitySummarizer } from "../services/activitySummarizer.js";

const collaborationModeSchema = z.enum(["default", "plan"]);
const sendInputSchema = z.object({ text: z.string().min(1).max(200_000), mode: collaborationModeSchema.optional() });
const createSessionSchema = z.object({
  sourceSessionId: z.string().min(1),
  name: z.string().trim().min(1).max(80)
});
const queuedInputSchema = z.object({ text: z.string().min(1).max(200_000), mode: collaborationModeSchema.optional() });
const DEFAULT_MESSAGE_PAGE_SIZE = 80;
const MAX_MESSAGE_PAGE_SIZE = 250;
const approvalSchema = z.object({
  decision: z.enum(["approve_once", "approve_for_prefix", "deny"])
});
const questionAnswerSchema = z.object({
  answers: z.record(
    z.object({
      answers: z.array(z.string().min(1).max(20_000)).min(1)
    })
  )
});
const activitySummarySettingsSchema = z.object({ enabled: z.boolean() });
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("archiveTranscript") }),
  z.object({ type: z.literal("setInputMode"), mode: collaborationModeSchema }),
  z.object({ type: z.literal("choosePlanAction"), action: z.enum(["implement", "clear_context_implement", "stay_in_plan"]) }),
  z.object({ type: z.literal("rename"), name: z.string().min(1).max(80) }),
  z.object({ type: z.literal("detach") }),
  z.object({ type: z.literal("kill") })
]);

export function registerRoutes(
  app: FastifyInstance,
  manager: SessionManager,
  events: EventBus,
  db: AppDatabase,
  config: AppConfig,
  access: AccessControl,
  codexUsage?: CodexUsageService,
  activitySummarizer?: ActivitySummarizer
): void {
  app.get("/api/connectivity", { preHandler: access.requireAccess }, async () => buildConnectivity(config));

  app.get("/api/remote-access", { preHandler: access.requireLocalAccess }, async () => buildRemoteAccess(config, access.currentAccessKey()));

  app.post("/api/remote-access/revoke", { preHandler: access.requireLocalAccess }, async () => {
    const nextKey = access.revokeRemoteAccess();
    return buildRemoteAccess(config, nextKey);
  });

  app.get("/api/codex/skills", { preHandler: access.requireAccess }, async (): Promise<CodexSkillsResponse> => ({
    skills: await discoverCodexSkills(config.codexHome)
  }));

  app.get("/api/sessions/:id/skills", { preHandler: access.requireAccess }, async (request, reply): Promise<CodexSkillsResponse | void> => {
    const { id } = request.params as { id: string };
    const session = await manager.getSession(id);
    if (!session) {
      await reply.code(404).send({ error: "Session not found" });
      return;
    }
    const workspaceRoots = [session.repo.root, session.tmux.cwd].filter((path): path is string => Boolean(path));
    return { skills: await discoverCodexSkills(config.codexHome, workspaceRoots) };
  });

  app.get("/api/sessions", { preHandler: access.requireAccess }, async (request) => {
    const query = request.query as { includeArchived?: string; includeAll?: string; status?: string; q?: string };
    let sessions = await manager.listSessions(query.includeArchived === "true");
    if (query.includeAll !== "true") sessions = sessions.filter((session) => session.status !== "missing");
    if (query.status) sessions = sessions.filter((session) => session.status === query.status);
    if (query.q) {
      const q = query.q.toLowerCase();
      sessions = sessions.filter((session) =>
        [
          session.repo.name,
          session.repo.branch,
          session.tmux.cwd,
          session.tmux.sessionName,
          session.tmux.windowId,
          String(session.tmux.windowIndex),
          session.tmux.windowName,
          session.tmux.paneId,
          String(session.tmux.paneIndex),
          session.preview,
          session.activitySummary,
          ...session.recentUserPrompts
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q))
      );
    }
    return { sessions };
  });

  app.post("/api/sessions", { preHandler: access.requireAccess }, async (request, reply) => {
    const body: CreateSessionRequest = createSessionSchema.parse(request.body);
    try {
      const session = await manager.createSessionFromSession(body.sourceSessionId, body.name);
      return reply.code(201).send({ session });
    } catch (error) {
      if (error instanceof CreateSessionError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/sessions/:id", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await manager.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return { session };
  });

  app.get("/api/sessions/:id/messages", { preHandler: access.requireAccess }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { after?: string; before?: string; limit?: string; position?: string };
    const limit = parseMessagePageLimit(query.limit);
    if (query.position === "oldest") return manager.listEarliestMessages(id, limit);

    const before = parsePositiveSequence(query.before);
    if (before !== null) return manager.listMessagesBefore(id, before, limit);

    const after = parsePositiveSequence(query.after);
    if (after !== null) return manager.listMessagesAfterPage(id, after, limit);

    return manager.listActiveTailMessages(id, limit);
  });

  app.get("/api/sessions/:id/messages/range", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { from?: string; to?: string };
    const from = parsePositiveSequence(query.from);
    const to = parsePositiveSequence(query.to);
    if (from === null || to === null) return reply.code(400).send({ error: "from and to are required positive sequence values" });
    return manager.listMessageRange(id, from, to);
  });

  app.get("/api/sessions/:id/approval", { preHandler: access.requireAccess }, async (request) => {
    const { id } = request.params as { id: string };
    return { approval: await manager.getPendingApproval(id) };
  });

  app.post("/api/sessions/:id/approval", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body: ResolveApprovalRequest = approvalSchema.parse(request.body);
    try {
      await manager.resolveApproval(id, body);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      if (error instanceof ApprovalResolutionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/sessions/:id/question", { preHandler: access.requireAccess }, async (request) => {
    const { id } = request.params as { id: string };
    return { question: await manager.getPendingQuestion(id) };
  });

  app.post("/api/sessions/:id/question", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body: QuestionAnswerRequest = questionAnswerSchema.parse(request.body);
    try {
      await manager.answerQuestion(id, body);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      if (error instanceof QuestionResolutionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/sessions/:id/input", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body: SendInputRequest = sendInputSchema.parse(request.body);
    try {
      await manager.sendInput(id, body.text, body.mode);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      if (error instanceof InputModeSwitchError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/sessions/:id/queued-inputs", { preHandler: access.requireAccess }, async (request) => {
    const { id } = request.params as { id: string };
    return { queuedInputs: await manager.listQueuedInputs(id) };
  });

  app.post("/api/sessions/:id/queued-inputs", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = queuedInputSchema.parse(request.body);
    try {
      const input = await manager.enqueueInput(id, body.text, body.mode);
      return reply.code(201).send({ queuedInput: input });
    } catch (error) {
      if (error instanceof QueuedInputError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.patch("/api/sessions/:id/queued-inputs/:queuedId", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, queuedId } = request.params as { id: string; queuedId: string };
    const body = queuedInputSchema.parse(request.body);
    try {
      const input = await manager.updateQueuedInput(id, queuedId, body.text, body.mode);
      return { queuedInput: input };
    } catch (error) {
      if (error instanceof QueuedInputError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/sessions/:id/queued-inputs/:queuedId", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, queuedId } = request.params as { id: string; queuedId: string };
    try {
      await manager.deleteQueuedInput(id, queuedId);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      if (error instanceof QueuedInputError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/sessions/:id/actions", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const action = actionSchema.parse(request.body) as SessionAction;
    const session = await manager.act(id, action);
    return reply.code(202).send({ ok: true, session });
  });

  app.get("/api/openai-usage/summary", { preHandler: access.requireAccess }, async (request) => {
    const query = request.query as { days?: string };
    return {
      configured: Boolean(config.openaiApiKey),
      activitySummariesEnabled: await db.getActivitySummariesEnabled(),
      ...(await db.summarizeOpenAIUsage(Number(query.days ?? 30)))
    };
  });

  app.patch("/api/activity-summaries/settings", { preHandler: access.requireAccess }, async (request) => {
    const body = activitySummarySettingsSchema.parse(request.body) as UpdateActivitySummarySettingsRequest;
    const enabled = await db.setActivitySummariesEnabled(body.enabled);
    activitySummarizer?.setEnabled(enabled);
    return { enabled };
  });

  app.get("/api/codex-usage/summary", { preHandler: access.requireAccess }, async () => {
    if (!codexUsage) {
      return {
        available: false,
        error: "Codex usage service is not configured.",
        refreshedAt: new Date().toISOString(),
        account: null,
        limits: { fiveHour: null, weekly: null }
      };
    }
    return codexUsage.summary();
  });

  app.get("/api/events", { websocket: true, preHandler: access.requireAccess }, (socket, request) => {
    access.trackRemoteSocket(request, socket);
    const unsubscribe = events.subscribe((event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on("close", () => {
      unsubscribe();
      access.untrackRemoteSocket(socket);
    });
    socket.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  });
}

function parsePositiveSequence(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function parseMessagePageLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_MESSAGE_PAGE_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_MESSAGE_PAGE_SIZE;
  return Math.min(MAX_MESSAGE_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}
