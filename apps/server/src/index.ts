import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { loadConfig } from "./config/config.js";
import { AppDatabase } from "./db/database.js";
import { TmuxAdapter } from "./tmux/tmuxAdapter.js";
import { CodexSessionStore } from "./codex/codexSessionStore.js";
import { CodexProcessResolver } from "./codex/codexProcessResolver.js";
import { EventBus } from "./services/eventBus.js";
import { SessionManager } from "./services/sessionManager.js";
import { createAccessControl } from "./auth/auth.js";
import { registerRoutes } from "./api/routes.js";
import { ActivitySummarizer, OpenAIActivitySummaryClient } from "./services/activitySummarizer.js";
import { buildOpenAIModelPricingTable } from "./services/openaiPricing.js";
import { CodexModelsService, CodexUsageService } from "./services/codexUsage.js";
import { PwaTrustServer } from "./services/pwaTrustServer.js";
import { NotificationService } from "./services/notifications.js";
import { eventId } from "./utils/ids.js";
import { nowIso } from "./utils/time.js";
import { GitWorkspaceManager } from "./services/gitWorkspaceManager.js";
import { SessionTransferService } from "./services/sessionTransfer.js";
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

const config = loadConfig();
const app = Fastify({ logger: { level: config.logLevel } });
const db = new AppDatabase(config.dbPath);
const tmux = new TmuxAdapter(config.inputSubmitKeys);
const codex = new CodexSessionStore(config.codexHome);
const codexProcessResolver = new CodexProcessResolver();
const events = new EventBus();
const codexUsage = new CodexUsageService({ codexHome: config.codexHome, logger: app.log });
const codexModels = new CodexModelsService({ codexHome: config.codexHome, logger: app.log });
const pwaTrustServer = new PwaTrustServer(config, app.log);
const gitWorkflowBroker = new GitWorkflowBroker(db, join(config.dataDir, "runtime", "git-workflow-broker.sock"), app.log);
await gitWorkflowBroker.start();
const gitWorkspaces = new GitWorkspaceManager(db, {
  worktreeRoot: config.gitWorktreeRoot,
  sessionRoot: config.gitSessionRoot,
  publishCapability: (workspace) => gitWorkflowBroker.publishCapability(workspace)
});
const notifications = new NotificationService(db, events, app.log);
const summaryClient = config.openaiApiKey
  ? new OpenAIActivitySummaryClient(config.openaiApiKey, config.summaryModel)
  : null;
const openaiPricingTable = buildOpenAIModelPricingTable(config.openaiPricingJson);
const activitySummariesEnabled = await db.getActivitySummariesEnabled();
const activitySummarizer = new ActivitySummarizer({
  db,
  client: summaryClient,
  pricingTable: openaiPricingTable,
  debounceMs: config.summaryDebounceMs,
  intervalMs: config.summaryIntervalMs,
  enabled: activitySummariesEnabled,
  onSummaryUpdated: (sessionId) => {
    void db.getSession(sessionId).then((session) => {
      if (!session) return;
      const event = {
        id: eventId(),
        type: "session.updated" as const,
        sessionId,
        payload: session,
        timestamp: nowIso()
      };
      events.publish(event);
    });
  },
  logger: app.log
});
let dockerProxy: DockerResourceProxy | null = null;
const userSystemd = await detectSessionScopeCapability(true);
const sessionScopes = config.resourceGovernor === "off"
  ? { ...userSystemd, configured: false, available: false, unavailableReason: "disabled" as const }
  : userSystemd;
const appServerCompatibility = await probeAppServerCompatibility(userSystemd.available);
if (!appServerCompatibility.available) {
  app.log.warn(
    { status: appServerCompatibility.status, detail: appServerCompatibility.detail },
    "Codex app-server sessions are unavailable; legacy tmux sessions remain enabled"
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
const sessionDrivers = createSessionDriverRegistry({
  compatibility: appServerCompatibility,
  dataDir: config.dataDir,
  codexHome: config.codexHome,
  environment: managedEnvironment,
  db,
  events
});
const manager = new SessionManager(
  db,
  tmux,
  codex,
  events,
  config.discoveryIntervalMs,
  config.parserIntervalMs,
  config.approvalKeys,
  config.inputModeCycleKeys,
  sessionDocuments,
  activitySummarizer,
  codexProcessResolver,
  gitWorkspaces,
  config.codexHome,
  config.gitWorktreeRoot,
  managedEnvironment,
  codexModels,
  sessionDrivers,
  config.appServerHibernateMs,
  config.defaultSessionDriver
);
const btw = BtwService.create({ db, events, codexHome: config.codexHome, logger: app.log, documents: manager });
const sessionOrchestrationBroker = new SessionOrchestrationBroker(
  db,
  manager,
  join(config.dataDir, "runtime", "session-orchestration.sock"),
  join(config.dataDir, "runtime", "session-capabilities"),
  app.log,
  new RawSessionEvidenceReader(config.codexHome, undefined, undefined, config.dataDir)
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
    runnerPath: join(config.codexHome, "skills", "muxpilot-git-workflow", "scripts", "muxpilot-git-run.mjs"),
    logger: app.log
  }
);
manager.setHeavyCommandQueue(heavyCommands);
await heavyCommands.start(manager);
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
const sessionTransfers = new SessionTransferService(db, manager, config.sessionFileKey);
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

access.register(app);
registerRoutes(app, manager, events, db, config, access, codexUsage, activitySummarizer, notifications, sessionTransfers, heavyCommands, btw, appServerCompatibility);

app.get("/healthz", async () => ({
  ok: true,
  appServerCompatibility,
  resourceGovernor: resourceGovernor.snapshot(),
  dockerGuardActive: Boolean(dockerProxy)
}));

let closing = false;

await manager.prepareStartupRecovery();
await btw.start();
await manager.discoverNow();
await manager.finishStartupRecovery();
manager.start({ runInitialTick: false });
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
