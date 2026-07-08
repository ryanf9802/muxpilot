import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  CodexSkillsResponse,
  CreateSessionRequest,
  PushSubscriptionInput,
  QuestionAnswerRequest,
  ResolveApprovalRequest,
  SendInputRequest,
  SessionDirectoriesResponse,
  SessionAction,
  UpdateNotificationSettingRequest,
  UpdateActivitySummarySettingsRequest,
  UpdateRemoteAccessSettingsRequest
} from "@muxpilot/core";
import { isValidSessionName, normalizeSessionName } from "@muxpilot/core";
import {
  ApprovalResolutionError,
  CreateSessionError,
  InputModeSwitchError,
  QuestionResolutionError,
  QueuedInputError,
  SessionNotFoundError,
  SessionNameError,
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
import type { NotificationService } from "../services/notifications.js";

const collaborationModeSchema = z.enum(["default", "plan"]);
const inputBodySchema = z
  .object({ text: z.string().max(200_000).default(""), mode: collaborationModeSchema.optional() })
  .refine((value) => Boolean(value.text.trim()), { message: "Input is empty" });
const sendInputSchema = inputBodySchema;
const sessionNameSchema = z
  .string()
  .max(4096)
  .transform((value) => normalizeSessionName(value))
  .refine((value) => isValidSessionName(value), { message: "Session name must be 2-32 lowercase letters, numbers, or hyphens" });
const createSessionSchema = z.object({
  cwd: z.string().trim().min(1).max(4096),
  name: sessionNameSchema
});
const queuedInputSchema = inputBodySchema;
const DEFAULT_MESSAGE_PAGE_SIZE = 80;
const MAX_MESSAGE_PAGE_SIZE = 250;
const DEFAULT_PROMPT_HISTORY_LIMIT = 30;
const MAX_PROMPT_HISTORY_LIMIT = 100;
const DEFAULT_TRANSCRIPT_SEARCH_LIMIT = 100;
const MAX_TRANSCRIPT_SEARCH_LIMIT = 500;
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
const remoteAccessSettingsSchema = z.object({ unrestrictedRemoteAccess: z.boolean() });
const notificationRuleTypeSchema = z.enum(["done_task", "approval_gate", "status_change"]);
const notificationSettingSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global"), type: notificationRuleTypeSchema, enabled: z.boolean() }),
  z.object({ scope: z.literal("session"), sessionId: z.string().min(1), type: notificationRuleTypeSchema, enabled: z.boolean() })
]);
const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("archiveTranscript") }),
  z.object({ type: z.literal("setInputMode"), mode: collaborationModeSchema }),
  z.object({ type: z.literal("choosePlanAction"), action: z.enum(["implement", "clear_context_implement", "stay_in_plan"]) }),
  z.object({ type: z.literal("rename"), name: sessionNameSchema }),
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
  activitySummarizer?: ActivitySummarizer,
  notificationService?: NotificationService
): void {
  app.get("/api/connectivity", { preHandler: access.requireAccess }, async () =>
    buildConnectivity(config, undefined, access.isUnrestrictedRemoteAccessEnabled())
  );

  app.get("/api/remote-access", { preHandler: access.requireLocalAccess }, async () =>
    buildRemoteAccess(config, access.currentAccessKey(), undefined, access.isUnrestrictedRemoteAccessEnabled())
  );

  app.post("/api/remote-access/revoke", { preHandler: access.requireLocalAccess }, async () => {
    const nextKey = access.revokeRemoteAccess();
    return buildRemoteAccess(config, nextKey, undefined, access.isUnrestrictedRemoteAccessEnabled());
  });

  app.patch("/api/remote-access/settings", { preHandler: access.requireLocalAccess }, async (request) => {
    const parsed = remoteAccessSettingsSchema.parse(request.body) satisfies UpdateRemoteAccessSettingsRequest;
    await db.setUnrestrictedRemoteAccessEnabled(parsed.unrestrictedRemoteAccess);
    access.setUnrestrictedRemoteAccessEnabled(parsed.unrestrictedRemoteAccess);
    return buildRemoteAccess(config, access.currentAccessKey(), undefined, access.isUnrestrictedRemoteAccessEnabled());
  });

  app.get("/api/notifications/settings", { preHandler: access.requireAccess }, async () => db.getNotificationSettings());

  app.patch("/api/notifications/settings", { preHandler: access.requireAccess }, async (request) => {
    const parsed = notificationSettingSchema.parse(request.body) satisfies UpdateNotificationSettingRequest;
    return db.setNotificationRule(parsed.scope, parsed.scope === "session" ? parsed.sessionId : null, parsed.type, parsed.enabled, new Date().toISOString());
  });

  app.get("/api/notifications/push-key", { preHandler: access.requireAccess }, async () => ({
    publicKey: notificationService ? await notificationService.publicPushKey() : ""
  }));

  app.post("/api/notifications/push-subscriptions", { preHandler: access.requireAccess }, async (request) => {
    const parsed = pushSubscriptionSchema.parse(request.body) satisfies PushSubscriptionInput;
    await db.upsertPushSubscription(parsed, new Date().toISOString());
    return { ok: true };
  });

  app.delete("/api/notifications/push-subscriptions", { preHandler: access.requireAccess }, async (request) => {
    const parsed = z.object({ endpoint: z.string().url() }).parse(request.body);
    await db.deletePushSubscription(parsed.endpoint);
    return { ok: true };
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

  app.get("/api/session-directories", { preHandler: access.requireAccess }, async (): Promise<SessionDirectoriesResponse> => ({
    directories: await manager.listSessionDirectories()
  }));

  app.get("/api/prompt-history", { preHandler: access.requireAccess }, async (request) => {
    const query = request.query as { q?: string; limit?: string };
    return {
      results: await db.listPromptHistory(String(query.q ?? "").slice(0, 2000), parsePromptHistoryLimit(query.limit))
    };
  });

  app.post("/api/sessions", { preHandler: access.requireAccess }, async (request, reply) => {
    const body: CreateSessionRequest = createSessionSchema.parse(request.body);
    try {
      const session = await manager.createSessionInDirectory(body.cwd, body.name);
      return reply.code(201).send({ session });
    } catch (error) {
      if (error instanceof SessionNameError) return reply.code(error.statusCode).send({ error: error.message });
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

  app.get("/api/sessions/:id/messages", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { after?: string; around?: string; before?: string; limit?: string; position?: string };
    const limit = parseMessagePageLimit(query.limit);
    try {
      if (query.position === "oldest") return await manager.listEarliestMessages(id, limit);

      const around = parsePositiveSequence(query.around);
      if (around !== null) return await manager.listMessagesAround(id, around, limit);

      const before = parsePositiveSequence(query.before);
      if (before !== null) return await manager.listMessagesBefore(id, before, limit);

      const after = parsePositiveSequence(query.after);
      if (after !== null) return await manager.listMessagesAfterPage(id, after, limit);

      return await manager.listActiveTailMessages(id, limit);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/sessions/:id/messages/search", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { q?: string; limit?: string };
    const q = typeof query.q === "string" ? query.q : "";
    const limit = parseBoundedPositiveInteger(query.limit, DEFAULT_TRANSCRIPT_SEARCH_LIMIT, MAX_TRANSCRIPT_SEARCH_LIMIT);
    try {
      return await manager.searchMessages(id, q, limit);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/sessions/:id/messages/range", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { from?: string; to?: string };
    const from = parsePositiveSequence(query.from);
    const to = parsePositiveSequence(query.to);
    if (from === null || to === null) return reply.code(400).send({ error: "from and to are required positive sequence values" });
    try {
      return await manager.listMessageRange(id, from, to);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
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
    try {
      const session = await manager.act(id, action);
      return reply.code(202).send({ ok: true, session });
    } catch (error) {
      if (error instanceof SessionNameError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof InputModeSwitchError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
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

function parseBoundedPositiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function parsePromptHistoryLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PROMPT_HISTORY_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_PROMPT_HISTORY_LIMIT;
  return Math.min(MAX_PROMPT_HISTORY_LIMIT, Math.max(1, Math.floor(parsed)));
}
