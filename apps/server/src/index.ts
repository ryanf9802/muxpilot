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
import { CodexUsageService } from "./services/codexUsage.js";
import { PwaTrustServer } from "./services/pwaTrustServer.js";
import { NotificationService } from "./services/notifications.js";
import { eventId } from "./utils/ids.js";
import { nowIso } from "./utils/time.js";
import { GitWorkspaceManager } from "./services/gitWorkspaceManager.js";
import { SessionTransferService } from "./services/sessionTransfer.js";
import { ResourceGovernor } from "./services/resourceGovernor.js";
import { DockerResourceProxy } from "./services/dockerResourceProxy.js";
import { join } from "node:path";

const config = loadConfig();
const app = Fastify({ logger: { level: config.logLevel } });
const db = new AppDatabase(config.dbPath);
const tmux = new TmuxAdapter(config.inputSubmitKeys);
const codex = new CodexSessionStore(config.codexHome);
const codexProcessResolver = new CodexProcessResolver();
const codexUsage = new CodexUsageService({ codexHome: config.codexHome, logger: app.log });
const pwaTrustServer = new PwaTrustServer(config, app.log);
const events = new EventBus();
const gitWorkspaces = new GitWorkspaceManager(db, {
  worktreeRoot: config.gitWorktreeRoot,
  sessionRoot: config.gitSessionRoot
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
const managedEnvironment: Record<string, string> = {
  MUXPILOT_HEAVY_VALIDATION_CONCURRENCY: String(config.heavyValidationConcurrency)
};
if (config.resourceGovernor !== "off") {
  dockerProxy = new DockerResourceProxy({
    socketPath: join(config.dataDir, "runtime", "docker-guard.sock"),
    memorySoftPercent: config.dockerMemorySoftPercent,
    memoryHardPercent: config.dockerMemoryHardPercent,
    cpuPercent: config.dockerCpuPercent
  }, app.log);
  try {
    await dockerProxy.start();
    managedEnvironment.DOCKER_HOST = dockerProxy.dockerHost();
  } catch (error) {
    app.log.warn({ err: error }, "Docker resource proxy is unavailable; managed sessions will use their normal Docker configuration");
    dockerProxy = null;
  }
}
const manager = new SessionManager(
  db,
  tmux,
  codex,
  events,
  config.discoveryIntervalMs,
  config.parserIntervalMs,
  config.approvalKeys,
  config.inputModeCycleKeys,
  activitySummarizer,
  codexProcessResolver,
  gitWorkspaces,
  config.codexHome,
  config.gitWorktreeRoot,
  managedEnvironment
);
const resourceGovernor = new ResourceGovernor({
  enabled: config.resourceGovernor !== "off",
  agentMemorySoftPercent: config.agentMemorySoftPercent,
  agentMemoryHardPercent: config.agentMemoryHardPercent,
  agentCpuPercent: config.agentCpuPercent,
  sessionTasksMax: config.sessionTasksMax
}, () => db.listSessions(), app.log);
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
registerRoutes(app, manager, events, db, config, access, codexUsage, activitySummarizer, notifications, sessionTransfers);

app.get("/healthz", async () => ({
  ok: true,
  resourceGovernor: resourceGovernor.snapshot(),
  dockerGuardActive: Boolean(dockerProxy)
}));

let closing = false;

await manager.discoverNow();
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
  await resourceGovernor.stop();
  notifications.stop();
  codexUsage.stop();
  await pwaTrustServer.close();
  await dockerProxy?.close();
  await db.close();
  await app.close();
};

process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
