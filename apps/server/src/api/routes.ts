import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  CodexSkillsResponse,
  CreateSessionRequest,
  GitWorkspaceAction,
  PushSubscriptionInput,
  QuestionAnswerRequest,
  ResolveApprovalRequest,
  RestoreSessionResponse,
  SendInputRequest,
  SessionDirectoriesResponse,
  SessionHistoryResponse,
  SessionAction,
  MuxpilotGitSkillStatus,
  UpdateNotificationSettingRequest,
  UpdateActivitySummarySettingsRequest,
  UpdateRemoteAccessSettingsRequest
} from "@muxpilot/core";
import { isValidGitStyleName, isValidSessionName, normalizeGitStyleName, normalizeSessionName } from "@muxpilot/core";
import {
  ApprovalResolutionError,
  CreateSessionError,
  InputModeSwitchError,
  QuestionResolutionError,
  QueuedInputError,
  SessionRestoreError,
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
import { GitWorkspaceError } from "@muxpilot/git-workspaces";
import { muxpilotGitWorkflowSkillStatus } from "../services/bundledSkills.js";

const collaborationModeSchema = z.enum(["default", "plan"]);
const inputBodySchema = z
  .object({ text: z.string().max(200_000).default(""), mode: collaborationModeSchema.optional() })
  .refine((value) => Boolean(value.text.trim()), { message: "Input is empty" });
const sendInputSchema = inputBodySchema;
const sessionNameSchema = z
  .string()
  .max(4096)
  .transform((value) => normalizeSessionName(value))
  .refine((value) => isValidSessionName(value), { message: "Session name must be a 2-32 character Git-style name" });
const gitRevisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local_branch"), branch: z.string().trim().min(1).max(1024) }),
  z.object({ kind: z.literal("remote_branch"), remote: z.string().trim().min(1).max(255), branch: z.string().trim().min(1).max(1024) }),
  z.object({ kind: z.literal("local_tag"), tag: z.string().trim().min(1).max(1024) }),
  z.object({ kind: z.literal("remote_tag"), remote: z.string().trim().min(1).max(255), tag: z.string().trim().min(1).max(1024) }),
  z.object({ kind: z.literal("commit"), oid: z.string().trim().min(40).max(64), remote: z.string().trim().min(1).max(255).optional() })
]);
const createSessionSchema = z.object({
  cwd: z.string().trim().min(1).max(4096),
  name: sessionNameSchema,
  workspace: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("directory") }),
    z.object({
      mode: z.literal("git"),
      targetBranch: z.string().transform(normalizeGitStyleName).refine(isValidGitStyleName, "Target branch must be a 2-32 character Git-style name"),
      targetRemote: z.string().trim().min(1).max(255).optional(),
      targetSource: gitRevisionSchema.optional(),
      inspections: z.array(gitRevisionSchema).max(10).optional(),
      allowCachedRemote: z.boolean().optional()
    })
  ]).optional()
});
const gitWorkspaceActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("push") })
]);
const queuedInputSchema = inputBodySchema;
const DEFAULT_MESSAGE_PAGE_SIZE = 80;
const MAX_MESSAGE_PAGE_SIZE = 250;
const DEFAULT_PROMPT_HISTORY_LIMIT = 30;
const MAX_PROMPT_HISTORY_LIMIT = 100;
const DEFAULT_SESSION_HISTORY_LIMIT = 40;
const MAX_SESSION_HISTORY_LIMIT = 100;
const DEFAULT_TRANSCRIPT_SEARCH_LIMIT = 100;
const MAX_TRANSCRIPT_SEARCH_LIMIT = 500;
const approvalSchema = z.object({
  decision: z.enum(["approve_once", "approve_for_session", "approve_always", "approve_for_prefix", "deny"])
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
const notificationDeviceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/);
const notificationRuleTypeSchema = z.enum(["done_task", "approval_gate", "status_change"]);
const notificationSettingSchema = z.union([
  z.object({ deviceId: notificationDeviceIdSchema, setting: z.literal("rule"), scope: z.literal("global"), type: notificationRuleTypeSchema, enabled: z.boolean() }),
  z.object({
    deviceId: notificationDeviceIdSchema,
    setting: z.literal("rule"),
    scope: z.literal("session"),
    sessionId: z.string().min(1),
    type: notificationRuleTypeSchema,
    enabled: z.boolean()
  }),
  z.object({ deviceId: notificationDeviceIdSchema, setting: z.literal("delivery"), channel: z.enum(["push", "sound"]), enabled: z.boolean() })
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
  z.object({ type: z.literal("pin") }),
  z.object({ type: z.literal("unpin") }),
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

  app.get("/api/notifications/settings", { preHandler: access.requireAccess }, async (request) => {
    const { deviceId } = z.object({ deviceId: notificationDeviceIdSchema }).parse(request.query);
    return db.getNotificationSettings(deviceId);
  });

  app.patch("/api/notifications/settings", { preHandler: access.requireAccess }, async (request) => {
    const parsed = notificationSettingSchema.parse(request.body) satisfies UpdateNotificationSettingRequest;
    if (parsed.setting === "delivery") {
      return db.setNotificationDeliverySetting(parsed.deviceId, parsed.channel, parsed.enabled, new Date().toISOString());
    }
    return db.setNotificationRule(parsed.deviceId, parsed.scope, parsed.scope === "session" ? parsed.sessionId : null, parsed.type, parsed.enabled, new Date().toISOString());
  });

  app.get("/api/notifications/push-key", { preHandler: access.requireAccess }, async () => ({
    publicKey: notificationService ? await notificationService.publicPushKey() : ""
  }));

  app.post("/api/notifications/push-subscriptions", { preHandler: access.requireAccess }, async (request) => {
    const { deviceId } = z.object({ deviceId: notificationDeviceIdSchema }).parse(request.query);
    const parsed = pushSubscriptionSchema.parse(request.body) satisfies PushSubscriptionInput;
    await db.upsertPushSubscription(deviceId, parsed, new Date().toISOString());
    return { ok: true };
  });

  app.delete("/api/notifications/push-subscriptions", { preHandler: access.requireAccess }, async (request) => {
    const { deviceId } = z.object({ deviceId: notificationDeviceIdSchema }).parse(request.query);
    const parsed = z.object({ endpoint: z.string().url() }).parse(request.body);
    await db.deletePushSubscription(deviceId, parsed.endpoint);
    return { ok: true };
  });

  app.get("/api/codex/skills", { preHandler: access.requireAccess }, async (): Promise<CodexSkillsResponse> => ({
    skills: await discoverCodexSkills(config.codexHome)
  }));

  app.get("/api/codex/skills/muxpilot-git-workflow/status", { preHandler: access.requireAccess }, async (): Promise<MuxpilotGitSkillStatus> => {
    return muxpilotGitWorkflowSkillStatus(config.codexHome);
  });

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

  app.get("/api/git/repository-probe", { preHandler: access.requireAccess }, async (request) => {
    const { cwd } = z.object({ cwd: z.string().trim().min(1).max(4096) }).parse(request.query);
    return manager.probeGitRepository(cwd);
  });

  app.get("/api/git/target-branch-status", { preHandler: access.requireAccess }, async (request) => {
    const { cwd, branch } = z.object({
      cwd: z.string().trim().min(1).max(4096),
      branch: z.string().transform(normalizeGitStyleName).refine(isValidGitStyleName)
    }).parse(request.query);
    return { exists: await manager.targetGitBranchExists(cwd, branch) };
  });

  app.post("/api/internal/git-workspaces/:workspaceId/inspections", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) return reply.code(403).send({ error: "Local access required" });
    const { workspaceId } = request.params as { workspaceId: string };
    const token = String(request.headers["x-muxpilot-git-token"] ?? "");
    const revision = gitRevisionSchema.parse(request.body);
    try {
      return { workspace: await manager.addGitInspectionByCapability(workspaceId, token, revision) };
    } catch (error) {
      if (error instanceof GitWorkspaceError || error instanceof CreateSessionError) {
        return reply.code(error instanceof GitWorkspaceError && error.code === "invalid_capability" ? 403 : 409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/internal/git-workspaces/:workspaceId/finalize", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) return reply.code(403).send({ error: "Local access required" });
    const { workspaceId } = request.params as { workspaceId: string };
    const token = String(request.headers["x-muxpilot-git-token"] ?? "");
    const body = z.object({ allowUnreviewed: z.boolean().optional() }).parse(request.body ?? {});
    try {
      return await manager.finalizeGitWorkspaceByCapability(workspaceId, token, body.allowUnreviewed ?? false);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        return reply.code(409).send({ error: error.message, code: error.code, detail: error.causeText });
      }
      throw error;
    }
  });

  app.get("/api/prompt-history", { preHandler: access.requireAccess }, async (request) => {
    const query = request.query as { q?: string; limit?: string };
    return {
      results: await db.listPromptHistory(String(query.q ?? "").slice(0, 2000), parsePromptHistoryLimit(query.limit))
    };
  });

  app.get("/api/session-history", { preHandler: access.requireAccess }, async (request): Promise<SessionHistoryResponse> => {
    const query = request.query as { q?: string; limit?: string };
    return {
      results: await manager.listSessionHistory(String(query.q ?? "").slice(0, 2000), parseSessionHistoryLimit(query.limit))
    };
  });

  app.post("/api/session-history/:id/restore", { preHandler: access.requireAccess }, async (request, reply): Promise<RestoreSessionResponse | void> => {
    const { id } = request.params as { id: string };
    try {
      return await manager.restoreSession(id);
    } catch (error) {
      if (error instanceof SessionNotFoundError || error instanceof SessionRestoreError || error instanceof CreateSessionError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/api/sessions", { preHandler: access.requireAccess }, async (request, reply) => {
    const body = createSessionSchema.parse(request.body) as CreateSessionRequest;
    try {
      if (body.workspace?.mode === "git" && (await muxpilotGitWorkflowSkillStatus(config.codexHome)).status !== "current") {
        return reply.code(409).send({ error: "Run pnpm app start prod to install or update the muxpilot Git workflow skill before creating a Git session", code: "git_skill_required" });
      }
      const session = await manager.createSession(body);
      return reply.code(201).send({ session });
    } catch (error) {
      if (error instanceof SessionNameError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof CreateSessionError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof GitWorkspaceError) return reply.code(409).send({ error: error.message, code: error.code });
      throw error;
    }
  });

  app.post("/api/sessions/:id/git/actions", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const action: GitWorkspaceAction = gitWorkspaceActionSchema.parse(request.body);
    try {
      return { workspace: await manager.actOnGitWorkspace(id, action) };
    } catch (error) {
      if (error instanceof GitWorkspaceError || error instanceof CreateSessionError) {
        return reply.code(error instanceof CreateSessionError ? error.statusCode : 409).send({ error: error.message, code: error instanceof GitWorkspaceError ? error.code : undefined });
      }
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
    const socketDeviceId = notificationSocketDeviceId(request.query);
    const unsubscribe = events.subscribe((event) => {
      if (event.type === "notification.triggered" && !shouldSendNotificationEventToDevice(event.payload, socketDeviceId)) return;
      socket.send(JSON.stringify(event));
    });
    socket.on("close", () => {
      unsubscribe();
      access.untrackRemoteSocket(socket);
    });
    socket.send(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));
  });
}

function notificationSocketDeviceId(query: unknown): string | null {
  const parsed = z.object({ deviceId: notificationDeviceIdSchema.optional() }).safeParse(query);
  return parsed.success ? (parsed.data.deviceId ?? null) : null;
}

function shouldSendNotificationEventToDevice(payload: unknown, deviceId: string | null): boolean {
  if (!deviceId || !payload || typeof payload !== "object" || !("deviceId" in payload)) return false;
  return (payload as { deviceId?: unknown }).deviceId === deviceId;
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

function isLoopbackAddress(value: string): boolean {
  const normalized = value.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function parsePromptHistoryLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PROMPT_HISTORY_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_PROMPT_HISTORY_LIMIT;
  return Math.min(MAX_PROMPT_HISTORY_LIMIT, Math.max(1, Math.floor(parsed)));
}

function parseSessionHistoryLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_SESSION_HISTORY_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HISTORY_LIMIT;
  return Math.min(MAX_SESSION_HISTORY_LIMIT, Math.max(1, Math.floor(parsed)));
}
