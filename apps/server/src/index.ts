import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";
import { loadConfig } from "./config/config.js";
import { AppDatabase } from "./db/database.js";
import { CodexSessionStore } from "./codex/codexSessionStore.js";
import { EventBus } from "./services/eventBus.js";
import { SessionManager } from "./services/sessionManager.js";
import { createAccessControl } from "./auth/auth.js";
import { registerRoutes } from "./api/routes.js";
import { CodexModelsService, CodexUsageService } from "./services/codexUsage.js";
import { PwaTrustServer } from "./services/pwaTrustServer.js";
import { NotificationService } from "./services/notifications.js";
import { eventId } from "./utils/ids.js";
import { nowIso } from "./utils/time.js";
import { GitWorkspaceManager } from "./services/gitWorkspaceManager.js";
import { SessionTransferService } from "./services/sessionTransfer.js";
import { SessionEnvironmentService } from "./services/sessionEnvironment.js";
import { SessionDocumentService } from "./services/sessionDocuments.js";
import { ResourceGovernor, UserSystemdController } from "./services/resourceGovernor.js";
import { DockerResourceProxy } from "./services/dockerResourceProxy.js";
import { HeavyCommandService } from "./services/heavyCommands.js";
import { join } from "node:path";
import { GitWorkflowBroker } from "./services/gitWorkflowBroker.js";
import { SessionOrchestrationBroker } from "./services/sessionOrchestrationBroker.js";
import { detectSessionScopeCapability } from "./services/sessionScopes.js";
import { RawSessionEvidenceReader } from "./services/rawSessionEvidence.js";
import { BtwService } from "./services/btwService.js";
import { probeAppServerCompatibility } from "./services/appServerCompatibility.js";
import { randomBytes } from "node:crypto";
import { createSessionDriverRegistry } from "./services/sessionDrivers/appServerRuntime.js";
import { CodexGoalStore } from "./codex/codexGoalStore.js";
import { requestLogLevel, slowRequestThresholdMs } from "./services/requestLogging.js";
import { ApprovalReviewer } from "./services/approvalReviewer.js";
import { SessionImageService } from "./services/sessionImages.js";
import { CodexAuthLifecycle } from "./services/codexAuthLifecycle.js";

const config = loadConfig();
const app = Fastify({
  logger: { level: config.logLevel },
  logController: new LogController({ disableRequestLogging: true })
});
const slowRequestMs = slowRequestThresholdMs();
app.addHook("onResponse", (request, reply, done) => {
  const elapsedMs = reply.elapsedTime;
  const level = requestLogLevel(reply.statusCode, elapsedMs, slowRequestMs);
  if (level) {
    request.log[level]({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      elapsedMs: Math.round(elapsedMs)
    }, level === "error" ? "request failed" : "request was slow or unsuccessful");
  }
  done();
});
const db = new AppDatabase(config.dbPath);
const sessionImages = new SessionImageService(config.dataDir, db);
const codex = new CodexSessionStore(config.codexHome);
const events = new EventBus();
const codexAuth = new CodexAuthLifecycle(db, events, config.codexHome, config.dataDir, app.log);
const codexUsage = new CodexUsageService({ codexHome: config.codexHome, logger: app.log });
const codexModels = new CodexModelsService({ codexHome: config.codexHome, logger: app.log });
const pwaTrustServer = new PwaTrustServer(config, app.log);
const gitWorkflowBrokerSocketPath = join(config.dataDir, "runtime", "git-workflow-broker", "broker.sock");
const gitWorkflowBroker = new GitWorkflowBroker(db, gitWorkflowBrokerSocketPath, app.log);
await gitWorkflowBroker.start();
const gitWorkspaces = new GitWorkspaceManager(db, {
  worktreeRoot: config.gitWorktreeRoot,
  sessionRoot: config.gitSessionRoot,
  publishCapability: (workspace) => gitWorkflowBroker.publishCapability(workspace)
});
const approvalReviewer = new ApprovalReviewer(config.codexHome, app.log);
let dockerProxy: DockerResourceProxy | null = null;
const userSystemd = await detectSessionScopeCapability(true);
const sessionScopes = config.resourceGovernor === "off"
  ? { ...userSystemd, configured: false, available: false, unavailableReason: "disabled" as const }
  : userSystemd;
const appServerCompatibility = await probeAppServerCompatibility(userSystemd.available);
if (!appServerCompatibility.available) {
  app.log.warn(
    { status: appServerCompatibility.status, detail: appServerCompatibility.detail },
    "Codex app-server is unavailable; muxpilot is running in read-only history mode"
  );
}
const heavyLaunchToken = randomBytes(32).toString("hex");
if (sessionScopes.configured && !sessionScopes.available) {
  app.log.warn(
    { reason: sessionScopes.unavailableReason },
    "user systemd session scopes are unavailable; ordinary sessions remain available but agent-managed creation is disabled"
  );
}
const managedEnvironment: Record<string, string> = {
  ...(process.env.MUXPILOT_SHADOW === "1" ? { MUXPILOT_SHADOW: "1" } : {}),
  MUXPILOT_SKILL_HOME: config.skillHome,
  MUXPILOT_GIT_BROKER_SOCKET: gitWorkflowBrokerSocketPath,
  MUXPILOT_SESSION_SCOPES_AVAILABLE: sessionScopes.available ? "1" : "0",
  ...(sessionScopes.available ? sessionScopes.environment : {}),
  MUXPILOT_HEAVY_QUEUE_ENABLED: "1",
  MUXPILOT_HEAVY_COMPLETION_ENABLED: sessionScopes.available ? "1" : "0",
  ...(sessionScopes.available ? {
    MUXPILOT_HEAVY_BROKER_SOCKET: join(config.heavyValidationDir, "broker.sock"),
    MUXPILOT_HEAVY_BROKER_TOKEN: heavyLaunchToken
  } : {}),
  MUXPILOT_HEAVY_VALIDATION_CONCURRENCY: String(config.heavyValidationConcurrency),
  MUXPILOT_HEAVY_VALIDATION_DIR: config.heavyValidationDir,
  MUXPILOT_HEAVY_VALIDATION_INACTIVITY_WARN_MS: String(config.heavyValidationInactivityWarnMs),
  MUXPILOT_HEAVY_VALIDATION_INACTIVITY_TIMEOUT_MS: String(config.heavyValidationInactivityTimeoutMs),
  MUXPILOT_HEAVY_VALIDATION_RUNTIME_TIMEOUT_MS: String(config.heavyValidationRuntimeTimeoutMs),
  MUXPILOT_HEAVY_VALIDATION_TERMINATION_GRACE_MS: String(config.heavyValidationTerminationGraceMs),
  MUXPILOT_HEAVY_VALIDATION_RESUME_TIMEOUT_MS: String(config.heavyValidationResumeTimeoutMs)
};
if (config.resourceGovernor !== "off") {
  dockerProxy = new DockerResourceProxy({
    socketPath: join(config.dataDir, "runtime", "docker-guard.sock"),
    memorySoftPercent: config.dockerMemorySoftPercent,
    memoryHardPercent: config.dockerMemoryHardPercent,
    cpuPercent: config.dockerCpuPercent,
    heavyValidationDir: config.heavyValidationDir
  }, app.log);
  try {
    await dockerProxy.start();
    managedEnvironment.DOCKER_HOST = dockerProxy.dockerHost();
  } catch (error) {
    app.log.warn({ err: error }, "Docker resource proxy is unavailable; managed sessions will use their normal Docker configuration");
    dockerProxy = null;
  }
}
const sessionDocuments = new SessionDocumentService(config.gitSessionRoot);
const sessionEnvironment = new SessionEnvironmentService(db, config.dataDir);
await sessionEnvironment.initialize();
const sessionDrivers = createSessionDriverRegistry({
  compatibility: appServerCompatibility,
  dataDir: config.dataDir,
  runtimeDir: userSystemd.environment.XDG_RUNTIME_DIR,
  codexHome: config.codexHome,
  environment: managedEnvironment,
  sessionEnvironment,
  db,
  events,
  onAuthenticationFailure: (_sessionId, error) => codexAuth.reportAuthenticationFailure(error),
  onAccountUpdated: () => codexAuth.reportAccountUpdated()
});
const manager = new SessionManager(
  db,
  codex,
  events,
  config.discoveryIntervalMs,
  config.parserIntervalMs,
  sessionDocuments,
  approvalReviewer,
  gitWorkspaces,
  config.codexHome,
  config.gitWorktreeRoot,
  managedEnvironment,
  codexModels,
  sessionDrivers,
  config.appServerHibernateMs,
  (sessionId, imageId) => sessionImages.path(sessionId, imageId),
  sessionEnvironment
);
const btw = BtwService.create({ db, events, codexHome: config.codexHome, logger: app.log, documents: manager });
manager.setAuthenticationGuard(() => codexAuth.assertReady());
manager.setAuthenticationAvailabilityGuard(() => codexAuth.assertAvailable());
btw.setAuthenticationGuard(() => codexAuth.assertReady());
codexAuth.setRuntimeHooks({
  blockers: async () => [...new Set([...await manager.codexAuthenticationBlockers(), ...btw.authenticationBlockers()])],
  reconcile: (sessionIds) => manager.reconcileCodexAuthentication(sessionIds),
  suspend: () => manager.suspendForCodexSignOut(),
  invalidateConsumers: () => {
    codexUsage.invalidateAuthentication();
    codexModels.invalidateAuthentication();
    approvalReviewer.invalidateAuthentication();
    btw.invalidateAuthentication();
  },
  admissionReleased: () => manager.resumeQueuedInputsAfterAuthentication()
});
await codexAuth.start();
const rawSessionEvidence = new RawSessionEvidenceReader(
  config.codexHome,
  undefined,
  undefined,
  config.dataDir
);
const sessionOrchestrationBroker = new SessionOrchestrationBroker(
  db,
  manager,
  join(config.dataDir, "runtime", "session-orchestration.sock"),
  join(config.dataDir, "runtime", "session-capabilities"),
  app.log,
  rawSessionEvidence,
  new CodexGoalStore(config.codexHome)
);
await sessionOrchestrationBroker.start();
manager.setOrchestrationProvider(sessionOrchestrationBroker);
const heavyCommands = new HeavyCommandService(
  config.heavyValidationDir,
  config.gitSessionRoot,
  config.heavyValidationConcurrency,
  config.heavyValidationResumeTimeoutMs,
  {
    enabled: sessionScopes.available,
    environment: sessionScopes.environment,
    token: heavyLaunchToken,
    runnerPath: join(config.skillHome, "skills", "muxpilot-git-workflow", "scripts", "muxpilot-git-run.mjs"),
    logger: app.log
  }
);
manager.setHeavyCommandQueue(heavyCommands);
await heavyCommands.start(manager);
const notifications = new NotificationService(db, events, app.log, {
  pendingAutomaticWork: (sessionId) => manager.notificationPendingWorkReasons(sessionId),
  completionEvidence: (sessionId) => manager.notificationCompletionEvidence(sessionId),
  usageSummary: () => codexUsage.summary()
});
const resourceGovernor = new ResourceGovernor({
  configured: sessionScopes.configured,
  enabled: sessionScopes.available,
  unavailableReason: sessionScopes.unavailableReason,
  agentMemorySoftPercent: config.agentMemorySoftPercent,
  agentMemoryHardPercent: config.agentMemoryHardPercent,
  agentCpuPercent: config.agentCpuPercent,
  sessionTasksMax: config.sessionTasksMax
}, async () => {
  const runningWorkspaces = await heavyCommands.runningWorkspaceIds();
  return (await db.listSessions()).map((session) =>
    session.gitWorkspace && runningWorkspaces.has(session.gitWorkspace.id)
      ? { ...session, status: "executing" as const }
      : session
  );
}, app.log, new UserSystemdController(sessionScopes.environment), async () => {
  const [units, sessions] = await Promise.all([heavyCommands.runningResourceUnits(), db.listSessions()]);
  const sessionByWorkspace = new Map(sessions.flatMap((session) =>
    session.gitWorkspace ? [[session.gitWorkspace.id, session.id] as const] : []
  ));
  return units.flatMap(({ workspaceId, unit }) => {
    const sessionId = sessionByWorkspace.get(workspaceId);
    return sessionId ? [{ sessionId, scope: unit }] : [];
  });
});
manager.setResourceUsageLookup(resourceGovernor);
const sessionTransfers = new SessionTransferService(db, manager, sessionEnvironment);
await sessionTransfers.initialize();
const access = createAccessControl(config, {
  unrestrictedRemoteAccessEnabled: await db.getUnrestrictedRemoteAccessEnabled()
});

await app.register(cookie);
await app.register(cors, {
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, config.corsOrigins.includes(origin));
  }
});
await app.register(websocket);

app.addContentTypeParser(
  "application/vnd.muxpilot.session",
  { parseAs: "buffer", bodyLimit: 512 * 1024 * 1024 },
  (_request, body, done) => done(null, body)
);
app.addContentTypeParser(
  "application/vnd.muxpilot.session+passphrase",
  { parseAs: "buffer", bodyLimit: 512 * 1024 * 1024 + 4096 },
  (_request, body, done) => done(null, body)
);

access.register(app);
registerRoutes(app, manager, events, db, config, access, codexUsage, notifications, sessionTransfers, heavyCommands, btw, appServerCompatibility, sessionImages, codexAuth, sessionEnvironment);

app.get("/healthz", async () => ({
  ok: true,
  shadowMode: process.env.MUXPILOT_SHADOW === "1",
  appServerCompatibility,
  resourceGovernor: resourceGovernor.snapshot(),
  dockerGuardActive: Boolean(dockerProxy)
}));

let closing = false;

await manager.prepareStartupRecovery();
await btw.start();
approvalReviewer.start();
events.subscribe((event) => {
  if (event.type !== "message.appended") return;
  const message = event.payload && typeof event.payload === "object" ? event.payload as { id?: unknown; type?: unknown } : null;
  if (message?.type === "approval_request" && typeof message.id === "string") {
    void manager.handleAutomatedApproval(event.sessionId, message.id);
  }
});
await manager.discoverNow();
await manager.finishStartupRecovery();
await manager.recoverAppServerSessions();
await codexAuth.reconcileAfterStartup();
await manager.recoverAutomatedApprovals();
manager.start({ runInitialTick: false, recoverAppServerSessions: false });
resourceGovernor.start();
pwaTrustServer.start();
void startNotificationsAfterStartupCatchup();

async function startNotificationsAfterStartupCatchup(): Promise<void> {
  try {
    await manager.catchUpIngest();
  } catch (error) {
    app.log.error({ err: error }, "startup transcript catch-up failed");
  }
  if (closing) return;
  try {
    await notifications.start();
  } catch (error) {
    app.log.error({ err: error }, "notification service startup failed");
  }
}

const close = async () => {
  closing = true;
  manager.stop();
  await heavyCommands.stop();
  await resourceGovernor.stop();
  notifications.stop();
  await btw.stop();
  await codexAuth.stop();
  codexUsage.stop();
  codexModels.stop();
  await pwaTrustServer.close();
  await dockerProxy?.close();
  await gitWorkflowBroker.close();
  await sessionOrchestrationBroker.close();
  await manager.markCleanShutdown();
  await db.close();
  await app.close();
};

process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
