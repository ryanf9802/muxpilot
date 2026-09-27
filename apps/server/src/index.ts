import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";
import { loadConfig } from "./config/config.js";
import { AppDatabase } from "./db/database.js";
import { CodexSessionStore } from "./providers/codex/sessionStore.js";
import { EventBus } from "./services/eventBus.js";
import { SessionManager } from "./services/sessionManager.js";
import { createAccessControl } from "./auth/auth.js";
import { registerRoutes } from "./api/routes.js";
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
import { probeAppServerCompatibility } from "./providers/codex/compatibility.js";
import { randomBytes } from "node:crypto";
import { createCodexProvider } from "./providers/codex/provider.js";
import { ProviderRegistry } from "./providers/registry.js";
import { CodexGoalStore } from "./providers/codex/goalStore.js";
import { requestLogLevel, slowRequestThresholdMs } from "./services/requestLogging.js";
import { SessionImageService } from "./services/sessionImages.js";

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
const pwaTrustServer = new PwaTrustServer(config, app.log);
const gitWorkflowBrokerSocketPath = join(config.dataDir, "runtime", "git-workflow-broker", "broker.sock");
const gitWorkflowBroker = new GitWorkflowBroker(db, gitWorkflowBrokerSocketPath, app.log);
await gitWorkflowBroker.start();
const gitWorkspaces = new GitWorkspaceManager(db, {
  worktreeRoot: config.gitWorktreeRoot,
  sessionRoot: config.gitSessionRoot,
  publishCapability: (workspace) => gitWorkflowBroker.publishCapability(workspace)
});
let dockerProxy: DockerResourceProxy | null = null;
const userSystemd = await detectSessionScopeCapability(true);
const sessionScopes = config.resourceGovernor === "off"
  ? { ...userSystemd, configured: false, available: false, unavailableReason: "disabled" as const }
  : userSystemd;
const codexCompatibility = await probeAppServerCompatibility(userSystemd.available);
if (!codexCompatibility.available) {
  app.log.warn(
    { status: codexCompatibility.status, detail: codexCompatibility.detail },
    "Codex app-server is unavailable; Codex sessions are read-only history"
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
const codexProvider = createCodexProvider({
  compatibility: codexCompatibility,
  skillHome: config.skillHome,
  logger: app.log,
  dataDir: config.dataDir,
  runtimeDir: userSystemd.environment.XDG_RUNTIME_DIR,
  codexHome: config.codexHome,
  environment: managedEnvironment,
  sessionEnvironment,
  db,
  events
});
const providers = new ProviderRegistry([codexProvider], await db.getDefaultAgentProvider() ?? "codex");
const manager = new SessionManager({
  db,
  providers,
  codexStore: codex,
  events,
  discoveryIntervalMs: config.discoveryIntervalMs,
  parserIntervalMs: config.parserIntervalMs,
  documents: sessionDocuments,
  gitWorkspaces,
  codexHome: config.codexHome,
  gitWorktreeRoot: config.gitWorktreeRoot,
  managedEnvironment,
  appServerHibernateMs: config.appServerHibernateMs,
  imagePath: (sessionId, imageId) => sessionImages.path(sessionId, imageId),
  sessionEnvironment
});
const btw = BtwService.create({ db, events, codexHome: config.codexHome, logger: app.log, documents: manager });
btw.setAuthenticationGuard(() => codexProvider.auth.assertReady());
codexProvider.authLifecycle.setRuntimeHooks({
  blockers: async () => [...new Set([...await manager.providerAuthenticationBlockers("codex"), ...btw.authenticationBlockers()])],
  reconcile: (sessionIds) => manager.reconcileProviderAuthentication("codex", sessionIds),
  suspend: () => manager.suspendForProviderSignOut("codex"),
  invalidateConsumers: () => {
    codexProvider.usage.invalidateAuthentication();
    codexProvider.models.invalidateAuthentication();
    codexProvider.approvalReview.invalidateAuthentication();
    btw.invalidateAuthentication();
  },
  admissionReleased: () => manager.resumeQueuedInputsAfterAuthentication("codex")
});
await codexProvider.authLifecycle.start();
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
  usageSummaries: () => Promise.all(providers.list()
    .filter((provider) => provider.capabilities.usageLimits)
    .map((provider) => provider.usage.summary()))
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
registerRoutes(app, {
  manager,
  events,
  db,
  config,
  access,
  providers,
  notificationService: notifications,
  sessionTransfers,
  heavyCommands,
  btw,
  sessionImages,
  sessionEnvironment
});

app.get("/healthz", async () => ({
  ok: true,
  shadowMode: process.env.MUXPILOT_SHADOW === "1",
  providers: providers.list().map((provider) => provider.compatibility()),
  resourceGovernor: resourceGovernor.snapshot(),
  dockerGuardActive: Boolean(dockerProxy)
}));

let closing = false;

await manager.prepareStartupRecovery();
await btw.start();
for (const provider of providers.list()) provider.approvalReview?.start();
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
await codexProvider.authLifecycle.reconcileAfterStartup();
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
  await codexProvider.authLifecycle.stop();
  for (const provider of providers.list()) {
    provider.usage.stop();
    provider.models.stop();
    provider.approvalReview?.stop();
  }
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
