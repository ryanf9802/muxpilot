import type { FastifyInstance } from "fastify";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
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
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";

const collaborationModeSchema = z.enum(["default", "plan"]);
const composerPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(200_000) }),
  z.object({ type: z.literal("image"), attachmentId: z.string().min(1).max(200) })
]);
const inputBodySchema = z
  .object({ text: z.string().max(200_000).default(""), parts: z.array(composerPartSchema).max(200).optional(), mode: collaborationModeSchema.optional() })
  .refine((value) => inputBodyHasContent(value.text, value.parts), { message: "Input is empty" });
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
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MESSAGE_PAGE_SIZE = 80;
const MAX_MESSAGE_PAGE_SIZE = 250;
const DEFAULT_PROMPT_HISTORY_LIMIT = 30;
const MAX_PROMPT_HISTORY_LIMIT = 100;
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

  app.post("/api/sessions/:id/attachments", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await manager.getSession(id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    let upload: MultipartImageUpload;
    try {
      upload = await readMultipartImage(request.headers["content-type"], request.raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("large") ? 413 : 400).send({ error: message });
    }
    const extension = IMAGE_MIME_EXTENSIONS[upload.mimeType];
    if (!extension) return reply.code(415).send({ error: "Unsupported image type" });
    if (upload.data.length > MAX_ATTACHMENT_BYTES) return reply.code(413).send({ error: "Image is too large" });
    const attachmentId = eventId();
    const attachmentDir = resolve(config.dataDir, "attachments", id);
    await mkdir(attachmentDir, { recursive: true });
    const filename = safeAttachmentFilename(upload.filename, extension);
    const storagePath = join(attachmentDir, `${attachmentId}${extension}`);
    await writeFile(storagePath, upload.data);
    const attachment = {
      id: attachmentId,
      sessionId: id,
      filename,
      mimeType: upload.mimeType,
      sizeBytes: upload.data.length,
      storagePath,
      createdAt: nowIso()
    };
    await db.upsertAttachment(attachment);
    const { storagePath: _storagePath, ...publicAttachment } = attachment;
    return reply.code(201).send({ attachment: publicAttachment });
  });

  app.get("/api/sessions/:id/attachments/:attachmentId", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    const attachment = await db.getAttachment(id, attachmentId);
    if (!attachment) return reply.code(404).send({ error: "Attachment not found" });
    const data = await readFile(attachment.storagePath);
    return reply.type(attachment.mimeType).send(data);
  });

  app.get("/api/sessions/:id/messages", { preHandler: access.requireAccess }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { after?: string; before?: string; limit?: string; position?: string };
    const limit = parseMessagePageLimit(query.limit);
    try {
      if (query.position === "oldest") return await manager.listEarliestMessages(id, limit);

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
      await manager.sendInput(id, body.text, body.mode, body.parts);
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
      const input = await manager.enqueueInput(id, body.text, body.mode, body.parts);
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
      const input = await manager.updateQueuedInput(id, queuedId, body.text, body.mode, body.parts);
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

function parsePromptHistoryLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PROMPT_HISTORY_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_PROMPT_HISTORY_LIMIT;
  return Math.min(MAX_PROMPT_HISTORY_LIMIT, Math.max(1, Math.floor(parsed)));
}

function inputBodyHasContent(text: string, parts: Array<z.infer<typeof composerPartSchema>> | undefined): boolean {
  if (parts?.some((part) => part.type === "image" || (part.type === "text" && part.text.trim()))) return true;
  return Boolean(text.trim());
}

interface MultipartImageUpload {
  filename: string;
  mimeType: string;
  data: Buffer;
}

async function readMultipartImage(contentType: string | string[] | undefined, stream: NodeJS.ReadableStream): Promise<MultipartImageUpload> {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const boundary = multipartBoundary(header ?? "");
  if (!boundary) throw new Error("Expected multipart upload");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_ATTACHMENT_BYTES + 64 * 1024) throw new Error("Image is too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const parsed = parseMultipartBody(body, boundary);
  if (!parsed) throw new Error("Image file is required");
  return parsed;
}

function multipartBoundary(contentType: string): string | null {
  const match = contentType.match(/(?:^|;\s*)boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2] ?? null;
}

function parseMultipartBody(body: Buffer, boundary: string): MultipartImageUpload | null {
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString() === "--") return null;
    if (body.subarray(cursor, cursor + 2).toString() === "\r\n") cursor += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) return null;
    const headers = body.subarray(cursor, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart);
    if (nextBoundary < 0) return null;
    const disposition = headers.match(/content-disposition:[^\r\n]*/i)?.[0] ?? "";
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] ?? "image";
    const contentType = headers.match(/content-type:\s*([^\r\n;]+)/i)?.[1]?.trim().toLowerCase() ?? "";
    if (filename && contentType.startsWith("image/")) {
      return { filename, mimeType: contentType, data: body.subarray(dataStart, nextBoundary) };
    }
    cursor = body.indexOf(delimiter, nextBoundary);
  }
  return null;
}

function safeAttachmentFilename(filename: string, extension: string): string {
  const base = basename(filename).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  const withoutExtension = base ? base.slice(0, Math.max(0, base.length - extname(base).length)) : "image";
  return `${withoutExtension || "image"}${extension}`;
}
