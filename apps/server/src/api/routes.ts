import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type {
  BtwExchangeResponse,
  BtwExchangesResponse,
  AppServerCompatibility,
  CodexSkillsResponse,
  CreateSessionRequest,
  DashboardSessionSummary,
  ForkSessionRequest,
  ForkSessionResponse,
  PushSubscriptionInput,
  QuestionAnswerRequest,
  ResolveApprovalRequest,
  RestoreSessionResponse,
  RestoreSessionRequest,
  RestoreSessionRecoveryRequest,
  RestoreSessionRecoveryResponse,
  SessionRecoveryResponse,
  SendInputRequest,
  MessageContentPart,
  SessionDirectoriesResponse,
  SessionHistoryResponse,
  SessionSummaryListResponse,
  SessionSnapshotResponse,
  SessionTransferExportRequest,
  SessionTransferImportRequest,
  SessionAction,
  MuxpilotGitSkillStatus,
  UpdateNotificationSettingRequest,
  UpdateRemoteAccessSettingsRequest,
} from "@muxpilot/core";
import type { ManagedSession } from "@muxpilot/core";
import { isValidSessionName, normalizeSessionName } from "@muxpilot/core";
import {
  ApprovalResolutionError,
  AgentSessionError,
  CreateSessionError,
  FastModeSwitchError,
  ModelSettingsError,
  InputDeliveryError,
  InputModeSwitchError,
  QuestionResolutionError,
  QueuedInputError,
  SessionRestoreError,
  SessionNotFoundError,
  SessionNameError,
  SessionRuntimeActionError,
  type SessionManager
} from "../services/sessionManager.js";
import type { EventBus } from "../services/eventBus.js";
import type { AppDatabase } from "../db/database.js";
import type { AppConfig } from "../config/config.js";
import type { AccessControl } from "../auth/auth.js";
import { buildConnectivity, buildRemoteAccess } from "../services/connectivity.js";
import { discoverCodexSkills } from "../services/skillDiscovery.js";
import type { CodexUsageService } from "../services/codexUsage.js";
import type { NotificationService } from "../services/notifications.js";
import { GitWorkspaceError } from "../services/gitWorkspaceManager.js";
import { muxpilotGitWorkflowSkillStatus } from "../services/bundledSkills.js";
import { SessionTransferError, type SessionTransferService } from "../services/sessionTransfer.js";
import type { HeavyCommandService } from "../services/heavyCommands.js";
import { SessionDocumentError } from "../services/sessionDocuments.js";
import { BtwError, type BtwService } from "../services/btwService.js";
import { SessionImageError, type SessionImageService } from "../services/sessionImages.js";
import { CodexAuthUnavailableError, type CodexAuthLifecycle } from "../services/codexAuthLifecycle.js";

const collaborationModeSchema = z.enum(["default", "plan"]);
const modelSettingsSchema = z.object({
  mode: collaborationModeSchema,
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(100).nullable()
});
const approvalReviewerSettingsSchema = z.object({
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(100).nullable()
});
const restoreSessionRecoverySchema = z.object({
  incidentId: z.string().trim().min(1).max(200),
  sessionIds: z.array(z.string().trim().min(1).max(500)).min(1).max(100)
}).strict();
const restoreSessionSchema = z.object({}).strict();
const contentPartSchema: z.ZodType<MessageContentPart> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(200_000) }).strict(),
  z.object({ type: z.literal("image"), id: z.string().regex(/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]) }).strict()
]);
const inputBodyFields = z.object({ text: z.string().max(200_000).default(""), content: z.array(contentPartSchema).max(21).optional(), mode: collaborationModeSchema.optional() });
const inputBodySchema = inputBodyFields
  .refine((value) => (value.content?.filter((part) => part.type === "image").length ?? 0) <= 10, { message: "A message can contain at most 10 images" })
  .refine((value) => (value.content?.filter((part) => part.type === "text").reduce((sum, part) => sum + part.text.length, 0) ?? 0) <= 200_000, { message: "Message text is too long" })
  .refine((value) => value.content?.length
    ? value.content.some((part) => part.type === "image" || Boolean(part.text.trim()))
    : Boolean(value.text.trim()), { message: "Input is empty" });
const sendInputSchema = inputBodyFields
  .extend({ delivery: z.enum(["auto", "steer"]).optional() })
  .refine((value) => (value.content?.filter((part) => part.type === "image").length ?? 0) <= 10, { message: "A message can contain at most 10 images" })
  .refine((value) => (value.content?.filter((part) => part.type === "text").reduce((sum, part) => sum + part.text.length, 0) ?? 0) <= 200_000, { message: "Message text is too long" })
  .refine((value) => value.content?.length
    ? value.content.some((part) => part.type === "image" || Boolean(part.text.trim()))
    : Boolean(value.text.trim()), { message: "Input is empty" });
const imageUploadSchema = z.object({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string().max(14_000_000) }).strict();
function canonicalInputText(value: { text: string; content?: MessageContentPart[] }): string {
  return value.content?.length
    ? value.content.filter((part) => part.type === "text").map((part) => part.text).join("")
    : value.text;
}
const sessionNameSchema = z
  .string()
  .max(4096)
  .transform((value) => normalizeSessionName(value))
  .refine((value) => isValidSessionName(value), { message: "Session name must be a 2-32 character Git-style name" });
const createSessionSchema = z.object({
  cwd: z.string().trim().min(1).max(4096),
  name: sessionNameSchema,
  workspace: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("directory") }),
    z.object({
      mode: z.literal("git"),
      targetBranch: z.string().trim().min(1).max(1024)
    })
  ]).optional()
}).strict();
const forkSessionSchema = z.object({
  name: sessionNameSchema
}).strict();
const queuedInputSchema = inputBodySchema;
const btwQuestionSchema = z.object({ text: z.string().trim().min(1).max(20_000) });
const DEFAULT_MESSAGE_PAGE_SIZE = 80;
const MAX_MESSAGE_PAGE_SIZE = 250;
const DEFAULT_PROMPT_HISTORY_LIMIT = 30;
const MAX_PROMPT_HISTORY_LIMIT = 100;
const DEFAULT_SESSION_HISTORY_LIMIT = 40;
const MAX_SESSION_HISTORY_LIMIT = 100;
const DEFAULT_TRANSCRIPT_SEARCH_LIMIT = 100;
const MAX_TRANSCRIPT_SEARCH_LIMIT = 500;
const DASHBOARD_PREVIEW_MAX_LENGTH = 512;
const approvalSchema = z.object({
  decision: z.enum(["approve_once", "approve_for_session", "approve_always", "approve_for_prefix", "deny"]),
  messageId: z.string().min(1)
});
const questionAnswerSchema = z.object({
  messageId: z.string().min(1),
  answers: z.record(
    z.object({
      answers: z.array(z.string().min(1).max(20_000)).min(1)
    })
  )
});
const codexResetCreditSchema = z.object({
  idempotencyKey: z.string().uuid(),
  creditId: z.string().trim().min(1).max(500).nullable().optional()
}).strict();
const remoteAccessSettingsSchema = z.object({ unrestrictedRemoteAccess: z.boolean() });
const sessionDirectorySchema = z.object({ path: z.string().trim().min(1).max(4096) });
const sessionTransferExportSchema = z.object({ sessionIds: z.array(z.string().min(1)).min(1).max(500) });
const sessionTransferImportSchema = z.object({
  token: z.string().min(16).max(100),
  mappings: z.array(z.object({
    sourceCwd: z.string().min(1).max(4096),
    destinationCwd: z.string().min(1).max(4096),
    targetBranch: z.string().min(1).max(1024).optional()
  }).strict()).max(500)
}).strict();
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
  modelSettingsSchema.extend({ type: z.literal("setModelSettings") }),
  z.object({ type: z.literal("setApprovalMode"), mode: z.enum(["ask", "auto", "full"]) }),
  z.object({ type: z.literal("setFastMode"), enabled: z.boolean() }),
  z.object({ type: z.literal("setAgentParent"), parentSessionId: z.string().min(1).nullable() }),
  z.object({
    type: z.literal("choosePlanAction"),
    action: z.enum(["implement", "clear_context_implement", "stay_in_plan"]),
    messageId: z.string().min(1)
  }),
  z.object({
    type: z.literal("extendAgentBudget"),
    additionalTokens: z.number().int().min(1).max(2_000_000),
    reason: z.string().trim().min(1).max(1_000)
  }),
  z.object({ type: z.literal("retryInputDelivery") }),
  z.object({ type: z.literal("dismissInputDeliveryFailure") }),
  z.object({ type: z.literal("resumeAfterAuthentication") }),
  z.object({ type: z.literal("rename"), name: sessionNameSchema }),
  z.object({ type: z.literal("pin") }),
  z.object({ type: z.literal("unpin") }),
  z.object({ type: z.literal("detach") }),
  z.object({ type: z.literal("hibernate") }),
  z.object({ type: z.literal("wake") }),
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
  notificationService?: NotificationService,
  sessionTransfers?: SessionTransferService,
  heavyCommands?: HeavyCommandService,
  btw?: BtwService,
  appServerCompatibility?: AppServerCompatibility,
  sessionImages?: SessionImageService,
  codexAuth?: CodexAuthLifecycle
): void {
  app.get("/api/connectivity", { preHandler: access.requireAccess }, async () =>
    buildConnectivity(config, undefined, access.isUnrestrictedRemoteAccessEnabled())
  );

  if (appServerCompatibility) {
    app.get("/api/app-server/compatibility", { preHandler: access.requireAccess }, async (): Promise<AppServerCompatibility> =>
      appServerCompatibility
    );
  }

  app.get("/api/codex-models", { preHandler: access.requireAccess }, async (_request, reply) => {
    try {
      return await manager.codexModelCatalog();
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  if (codexAuth) {
    app.get("/api/codex-auth", { preHandler: access.requireAccess }, async () => codexAuth.state());
    app.post("/api/codex-auth/refresh", { preHandler: access.requireAccess }, async () => codexAuth.refresh());
  }

  app.get("/api/model-settings/defaults", { preHandler: access.requireAccess }, async (_request, reply) => {
    try {
      return { settings: await manager.globalModelSettings() };
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.patch("/api/model-settings/defaults", { preHandler: access.requireAccess }, async (request, reply) => {
    const body = modelSettingsSchema.parse(request.body);
    try {
      return { settings: await manager.updateGlobalModelSettings(body.mode, body.model, body.reasoningEffort) };
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof ModelSettingsError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/approval-reviewer/settings", { preHandler: access.requireAccess }, async () => ({
    settings: await manager.approvalReviewerSettings()
  }));

  app.patch("/api/approval-reviewer/settings", { preHandler: access.requireAccess }, async (request, reply) => {
    const body = approvalReviewerSettingsSchema.parse(request.body);
    try {
      return { settings: await manager.updateApprovalReviewerSettings(body.model, body.reasoningEffort) };
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof ModelSettingsError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  if (sessionTransfers) {
    app.get("/api/session-transfers/status", { preHandler: access.requireLocalAccess }, async () => ({
      encryptionEnabled: sessionTransfers.encryptionEnabled()
    }));

    app.post("/api/session-transfers/export", { preHandler: access.requireLocalAccess }, async (request, reply) => {
      try {
        const body = sessionTransferExportSchema.parse(request.body) satisfies SessionTransferExportRequest;
        const archive = await sessionTransfers.export(body.sessionIds);
        return reply
          .header("Content-Type", "application/vnd.muxpilot.session")
          .header("Content-Disposition", `attachment; filename="${archive.filename}"`)
          .send(archive.contents);
      } catch (error) {
        if (error instanceof SessionTransferError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    });

    app.post("/api/session-transfers/inspect", { preHandler: access.requireLocalAccess }, async (request, reply) => {
      try {
        if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "Upload a .mpsession file" });
        return await sessionTransfers.inspect(request.body);
      } catch (error) {
        if (error instanceof SessionTransferError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    });

    app.post("/api/session-transfers/import", { preHandler: access.requireLocalAccess }, async (request, reply) => {
      try {
        const body = sessionTransferImportSchema.parse(request.body) satisfies SessionTransferImportRequest;
        return await sessionTransfers.import(body.token, body.mappings);
      } catch (error) {
        if (error instanceof SessionTransferError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    });

    app.delete("/api/session-transfers/:token", { preHandler: access.requireLocalAccess }, async (request) => {
      const { token } = request.params as { token: string };
      await sessionTransfers.cancel(token);
      return { ok: true };
    });
  }

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
    return muxpilotGitWorkflowSkillStatus(config.skillHome);
  });

  app.get("/api/sessions/:id/skills", { preHandler: access.requireAccess }, async (request, reply): Promise<CodexSkillsResponse | void> => {
    const { id } = request.params as { id: string };
    const session = await manager.getSession(id);
    if (!session) {
      await reply.code(404).send({ error: "Session not found" });
      return;
    }
    const workspaceRoots = [session.gitWorkspace?.entryPath, session.repo.root, session.cwd]
      .filter((path): path is string => Boolean(path));
    return { skills: await discoverCodexSkills(config.codexHome, workspaceRoots) };
  });

  app.get("/api/sessions", { preHandler: access.requireAccess }, async (request) => {
    const query = request.query as { includeArchived?: string; includeAll?: string; status?: string; q?: string };
    let sessions = await manager.listSessions(query.includeArchived === "true", query.includeAll === "true");
    if (query.status) sessions = sessions.filter((session) => !session.initializing && session.status === query.status);
    if (query.q) sessions = sessions.filter((session) => sessionMatchesQuery(session, query.q!));
    return { sessions };
  });

  app.get("/api/session-summaries", { preHandler: access.requireAccess }, async (request): Promise<SessionSummaryListResponse> => {
    const query = request.query as { status?: string; q?: string };
    let sessions = await manager.listSessions(false, false);
    if (query.status) sessions = sessions.filter((session) => !session.initializing && session.status === query.status);
    if (query.q) sessions = sessions.filter((session) => sessionMatchesQuery(session, query.q!));
    return { sessions: sessions.map(dashboardSessionSummary) };
  });

  app.get("/api/session-directories", { preHandler: access.requireAccess }, async (): Promise<SessionDirectoriesResponse> => ({
    directories: await manager.listSessionDirectories()
  }));

  app.delete("/api/session-directories", { preHandler: access.requireAccess }, async (request) => {
    const { path } = sessionDirectorySchema.parse(request.body);
    await manager.dismissSessionDirectory(path);
    return { ok: true as const };
  });

  app.get("/api/git/repository-probe", { preHandler: access.requireAccess }, async (request) => {
    const { cwd } = z.object({ cwd: z.string().trim().min(1).max(4096) }).parse(request.query);
    return manager.probeGitRepository(cwd);
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
    const body = restoreSessionSchema.parse(request.body ?? {}) satisfies RestoreSessionRequest;
    try {
      return await manager.restoreSession(id);
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof SessionNotFoundError || error instanceof SessionRestoreError || error instanceof CreateSessionError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.get("/api/session-recovery", { preHandler: access.requireAccess }, async (): Promise<SessionRecoveryResponse> => ({
    incident: await manager.getSessionRecoveryIncident()
  }));

  app.post("/api/session-recovery/restore", { preHandler: access.requireAccess }, async (request, reply): Promise<RestoreSessionRecoveryResponse | void> => {
    const body = restoreSessionRecoverySchema.parse(request.body) as RestoreSessionRecoveryRequest;
    try {
      return await manager.restoreSessionRecovery(body.incidentId, body.sessionIds);
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof SessionRestoreError || error instanceof SessionNotFoundError || error instanceof CreateSessionError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.delete("/api/session-recovery/:id", { preHandler: access.requireAccess }, async (request) => {
    const { id } = request.params as { id: string };
    await manager.dismissSessionRecovery(id);
    return { ok: true as const };
  });

  app.post("/api/sessions", { preHandler: access.requireAccess }, async (request, reply) => {
    const body = createSessionSchema.parse(request.body) as CreateSessionRequest;
    try {
      if (body.workspace?.mode === "git" && (await muxpilotGitWorkflowSkillStatus(config.skillHome)).status !== "current") {
        return reply.code(409).send({ error: "Run pnpm app start prod to install or update the muxpilot Git workflow skill before creating a Git session", code: "git_skill_required" });
      }
      const session = await manager.createSession(body);
      return reply.code(201).send({ session });
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof SessionNameError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof CreateSessionError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof GitWorkspaceError) return reply.code(409).send({ error: error.message, code: error.code });
      throw error;
    }
  });

  app.post("/api/sessions/:id/fork", { preHandler: access.requireAccess }, async (request, reply): Promise<ForkSessionResponse | void> => {
    const { id } = request.params as { id: string };
    const body = forkSessionSchema.parse(request.body) as ForkSessionRequest;
    try {
      const source = await manager.getSession(id);
      if (!source) throw new SessionNotFoundError("Session not found");
      if (source.gitWorkspace && (await muxpilotGitWorkflowSkillStatus(config.skillHome)).status !== "current") {
        await reply.code(409).send({ error: "Run pnpm app start prod to install or update the muxpilot Git workflow skill before forking a Git session", code: "git_skill_required" });
        return;
      }
      const session = await manager.forkSession(id, body.name);
      return reply.code(201).send({ session });
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      if (error instanceof SessionNameError || error instanceof CreateSessionError || error instanceof SessionNotFoundError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      if (error instanceof GitWorkspaceError) {
        await reply.code(409).send({ error: error.message, code: error.code });
        return;
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

  app.get("/api/sessions/:id/documents", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await manager.listDocuments(id);
    } catch (error) {
      if (error instanceof SessionNotFoundError || error instanceof SessionDocumentError || error instanceof SessionRestoreError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/sessions/:id/documents/:name", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, name } = request.params as { id: string; name: string };
    try {
      return await manager.readDocument(id, name);
    } catch (error) {
      if (error instanceof SessionNotFoundError || error instanceof SessionDocumentError || error instanceof SessionRestoreError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/sessions/:id/snapshot", { preHandler: access.requireAccess }, async (request, reply): Promise<SessionSnapshotResponse | void> => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string };
    const session = await manager.getSession(id);
    if (!session) {
      await reply.code(404).send({ error: "Session not found" });
      return;
    }
    const limit = parseMessagePageLimit(query.limit);
    const [messages, approval, question, queuedInputs] = await Promise.all([
      manager.listActiveTailMessages(id, limit),
      manager.getPendingApproval(id),
      manager.getPendingQuestion(id),
      manager.listQueuedInputs(id)
    ]);
    return { session, messages, approval, question, queuedInputs, sampledAt: new Date().toISOString() };
  });

  app.get("/api/sessions/:id/heavy-commands", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await manager.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!heavyCommands || !session.gitWorkspace) return { commands: [], sampledAt: new Date().toISOString() };
    return heavyCommands.list(session.gitWorkspace.id);
  });

  app.get("/api/sessions/:id/heavy-commands/:runId/output", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const session = await manager.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!heavyCommands || !session.gitWorkspace) return reply.code(404).send({ error: "Heavyweight command not found" });
    const output = await heavyCommands.output(session.gitWorkspace.id, runId);
    if (!output) return reply.code(404).send({ error: "Heavyweight command not found" });
    return output;
  });

  app.post("/api/sessions/:id/heavy-commands/:runId/terminate", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const session = await manager.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!heavyCommands || !session.gitWorkspace) return reply.code(404).send({ error: "Heavyweight command not found" });
    const result = await heavyCommands.terminate(session.gitWorkspace.id, runId);
    if (result === "missing") return reply.code(404).send({ error: "Heavyweight command not found" });
    if (result === "inactive") return reply.code(409).send({ error: "Heavyweight command is no longer active" });
    return reply.code(202).send({ accepted: true });
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
      await sessionImages?.validate(id, body.content);
      const result = await manager.sendInput(id, canonicalInputText(body), body.mode, null, body.delivery, body.content);
      return reply.code(202).send("queuedInput" in result
        ? { ok: true, session: null, message: null, queuedInput: result.queuedInput }
        : { ok: true, ...result, queuedInput: null });
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof InputModeSwitchError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof InputDeliveryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof SessionRuntimeActionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof SessionImageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/sessions/:id/images", { preHandler: access.requireAccess, bodyLimit: 14_500_000 }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sessionImages) return reply.code(503).send({ error: "Image storage is unavailable" });
    try {
      const body = imageUploadSchema.parse(request.body);
      return reply.code(201).send({ image: await sessionImages.store(id, body.mimeType, body.data) });
    } catch (error) {
      if (error instanceof SessionImageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/sessions/:id/images/:imageId", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, imageId } = request.params as { id: string; imageId: string };
    if (!sessionImages) return reply.code(503).send({ error: "Image storage is unavailable" });
    try {
      const image = await sessionImages.read(id, imageId);
      return reply.type(image.mimeType).header("Cache-Control", "private, max-age=31536000, immutable").send(image.bytes);
    } catch (error) {
      if (error instanceof SessionImageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get("/api/sessions/:id/btw", { preHandler: access.requireAccess }, async (request, reply): Promise<BtwExchangesResponse | void> => {
    const { id } = request.params as { id: string };
    if (!btw) {
      await reply.code(503).send({ error: "BTW questions are unavailable" });
      return;
    }
    try {
      return { exchanges: await btw.list(id) };
    } catch (error) {
      if (error instanceof BtwError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/api/sessions/:id/btw", { preHandler: access.requireAccess }, async (request, reply): Promise<BtwExchangeResponse | void> => {
    const { id } = request.params as { id: string };
    if (!btw) {
      await reply.code(503).send({ error: "BTW questions are unavailable" });
      return;
    }
    const body = btwQuestionSchema.parse(request.body);
    try {
      return reply.code(202).send({ exchange: await btw.ask(id, body.text) });
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      if (error instanceof BtwError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post("/api/sessions/:id/btw/:exchangeId/cancel", { preHandler: access.requireAccess }, async (request, reply): Promise<BtwExchangeResponse | void> => {
    const { id, exchangeId } = request.params as { id: string; exchangeId: string };
    if (!btw) {
      await reply.code(503).send({ error: "BTW questions are unavailable" });
      return;
    }
    try {
      return reply.code(202).send({ exchange: await btw.cancel(id, exchangeId) });
    } catch (error) {
      if (error instanceof BtwError) {
        await reply.code(error.statusCode).send({ error: error.message });
        return;
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
      await sessionImages?.validate(id, body.content);
      const input = await manager.enqueueInput(id, canonicalInputText(body), body.mode, null, body.content);
      return reply.code(201).send({ queuedInput: input });
    } catch (error) {
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof QueuedInputError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof SessionImageError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.patch("/api/sessions/:id/queued-inputs/:queuedId", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, queuedId } = request.params as { id: string; queuedId: string };
    const body = queuedInputSchema.parse(request.body);
    try {
      await sessionImages?.validate(id, body.content);
      const input = await manager.updateQueuedInput(id, queuedId, canonicalInputText(body), body.mode, body.content);
      return { queuedInput: input };
    } catch (error) {
      if (error instanceof QueuedInputError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof SessionImageError) return reply.code(error.statusCode).send({ error: error.message });
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
      if (error instanceof CodexAuthUnavailableError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof SessionNameError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof InputModeSwitchError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof InputDeliveryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof SessionRuntimeActionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof FastModeSwitchError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof ModelSettingsError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AgentSessionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/codex-usage/summary", { preHandler: access.requireAccess }, async (request) => {
    const { refresh } = z.object({ refresh: z.enum(["0", "1"]).optional() }).parse(request.query);
    if (!codexUsage) {
      return {
        available: false,
        error: "Codex usage service is not configured.",
        refreshedAt: new Date().toISOString(),
        account: null,
        limits: { fiveHour: null, weekly: null },
        resetCredits: null
      };
    }
    return codexUsage.summary(refresh === "1");
  });

  app.get("/api/codex-usage/history", { preHandler: access.requireAccess }, async (request) => {
    const parsed = z.object({
      days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30)])).default(30),
      refresh: z.enum(["0", "1"]).optional()
    }).parse(request.query);
    if (!codexUsage) {
      return { available: false, error: "Codex usage service is not configured.", refreshedAt: new Date().toISOString(), days: parsed.days, summary: null, points: null };
    }
    return codexUsage.tokenUsage(parsed.days, parsed.refresh === "1");
  });

  app.post("/api/codex-usage/reset", { preHandler: access.requireAccess }, async (request, reply) => {
    if (!codexUsage) return reply.code(503).send({ error: "Codex usage service is not configured." });
    const body = codexResetCreditSchema.parse(request.body);
    return codexUsage.consumeResetCredit(body.idempotencyKey, body.creditId);
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

export function dashboardSessionSummary(session: ManagedSession): DashboardSessionSummary {
  const completedChild = Boolean(session.agentOwnership?.completedAt);
  const recentUserPrompts = completedChild
    ? []
    : session.recentUserPrompts.slice(0, 2).map(boundedDashboardPreview);
  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    provider: session.provider,
    repo: {
      root: session.repo.root,
      name: session.repo.name,
      branch: session.repo.branch,
      dirty: session.repo.dirty,
      worktree: null
    },
    codexSessionId: session.codexSessionId,
    codexJsonlPath: null,
    discoveryConfidence: session.discoveryConfidence,
    status: session.status,
    initializing: session.initializing,
    startupError: session.startupError,
    runtimeUnavailableReason: session.runtimeUnavailableReason,
    lastActivityAt: session.lastActivityAt,
    preview: "",
    recentUserPrompts,
    approvalMode: session.approvalMode,
    inputMode: session.inputMode,
    models: {
      default: { model: null, reasoningEffort: null },
      plan: { model: null, reasoningEffort: null }
    },
    fastMode: session.fastMode,
    transcriptSize: session.transcriptSize,
    unreadCount: session.unreadCount,
    pinned: session.pinned,
    archived: session.archived,
    forkedFrom: session.forkedFrom,
    resourceUsage: session.resourceUsage,
    contextUsage: session.contextUsage,
    agentOwnership: session.agentOwnership
      ? {
          parentSessionId: session.agentOwnership.parentSessionId,
          rootSessionId: session.agentOwnership.rootSessionId,
          origin: session.agentOwnership.origin,
          createdAt: "",
          workTokenBaseline: session.agentOwnership.workTokenBaseline,
          workTokenBudget: session.agentOwnership.workTokenBudget,
          completedAt: session.agentOwnership.completedAt,
          budgetExhaustedAt: session.agentOwnership.budgetExhaustedAt ?? null
        }
      : null,
    capabilities: session.capabilities?.kill === false ? session.capabilities : undefined,
    gitWorkspace: session.gitWorkspace
      ? {
          workflowVersion: 1,
          id: session.gitWorkspace.id,
          state: session.gitWorkspace.state,
          entryPath: session.gitWorkspace.entryPath,
          repoRoot: session.gitWorkspace.repoRoot,
          targetBranch: session.gitWorkspace.targetBranch,
          targetSha: "",
          sessionBranch: session.gitWorkspace.sessionBranch,
          worktreePath: session.gitWorkspace.worktreePath,
          lastError: session.gitWorkspace.lastError,
          updatedAt: "",
          dependencyLinks: []
        }
      : null
  };
}

export function sessionMatchesQuery(session: ManagedSession, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    session.name,
    session.cwd,
    session.repo.name,
    session.repo.branch,
    session.preview,
    ...session.recentUserPrompts
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle));
}

function boundedDashboardPreview(value: string): string {
  return [...value].slice(0, DASHBOARD_PREVIEW_MAX_LENGTH).join("");
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

function parseSessionHistoryLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_SESSION_HISTORY_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HISTORY_LIMIT;
  return Math.min(MAX_SESSION_HISTORY_LIMIT, Math.max(1, Math.floor(parsed)));
}
