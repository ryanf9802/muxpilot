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

const config = loadConfig();
const app = Fastify({ logger: { level: config.logLevel } });
const db = new AppDatabase(config.dbPath);
const tmux = new TmuxAdapter(config.inputSubmitKeys);
const codex = new CodexSessionStore(config.codexHome);
const codexProcessResolver = new CodexProcessResolver();
const codexUsage = new CodexUsageService({ codexHome: config.codexHome, logger: app.log });
const pwaTrustServer = new PwaTrustServer(config, app.log);
const events = new EventBus();
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
    void db.appendEvent(event);
    events.publish(event);
    });
  },
  logger: app.log
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
  activitySummarizer,
  codexProcessResolver
);
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

access.register(app);
registerRoutes(app, manager, events, db, config, access, codexUsage, activitySummarizer, notifications);

app.get("/healthz", async () => ({ ok: true }));

await notifications.start();
manager.start();
pwaTrustServer.start();

const close = async () => {
  manager.stop();
  notifications.stop();
  codexUsage.stop();
  await pwaTrustServer.close();
  await db.close();
  await app.close();
};

process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
