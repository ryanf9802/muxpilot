import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppServerCompatibility } from "@muxpilot/core";
import type { AppDatabase } from "../../db/database.js";
import type { EventBus } from "../eventBus.js";
import { CodexAppServerConnectionManager } from "./codexAppServerConnectionManager.js";
import { CodexAppServerDriver } from "./codexAppServerDriver.js";
import { CodexAppServerReconciler } from "./codexAppServerReconciler.js";
import { ProtocolJournal, protocolJournalPath } from "./protocolJournal.js";
import { SessionDriverRegistry } from "./registry.js";
import { SystemdAppServerSupervisor } from "./systemdAppServerSupervisor.js";

export interface AppServerRuntimeCompositionOptions {
  compatibility: AppServerCompatibility;
  dataDir: string;
  codexHome: string;
  environment: Record<string, string>;
  db: AppDatabase;
  events: EventBus;
  clientVersion?: string;
}

/** Builds side-effect-free app-server services; no process starts until a driver launch is requested. */
export function createSessionDriverRegistry(options: AppServerRuntimeCompositionOptions): SessionDriverRegistry {
  const registry = new SessionDriverRegistry();
  if (!options.compatibility.available) return registry;

  const runtimeRoot = join(options.dataDir, "runtime", "app-server-sessions");
  const journalRoot = join(options.dataDir, "protocol", "app-server-sessions");
  const journals = new Map<string, ProtocolJournal>();
  const supervisor = new SystemdAppServerSupervisor(runtimeRoot);
  const connections = new CodexAppServerConnectionManager(
    supervisor,
    (sessionId) => {
      const existing = journals.get(sessionId);
      if (existing) return existing;
      const journal = new ProtocolJournal(protocolJournalPath(journalRoot, appServerCapabilityId(sessionId)));
      journals.set(sessionId, journal);
      return journal;
    },
    options.clientVersion ?? "muxpilot/0.1.0"
  );
  const reconciler = new CodexAppServerReconciler(options.db, options.events);
  registry.register(new CodexAppServerDriver(supervisor, connections, {
    requestStore: options.db,
    eventSink: reconciler,
    runtimeSpec: (spec) => ({
      sessionId: spec.sessionId,
      capabilityId: appServerCapabilityId(spec.sessionId),
      cwd: spec.cwd,
      codexHome: options.codexHome,
      codexVersion: options.compatibility.codexVersion,
      environment: { ...options.environment, ...(spec.options.environment ?? {}) }
    })
  }));
  return registry;
}

export function appServerCapabilityId(sessionId: string): string {
  if (!sessionId.trim()) throw new Error("App-server session id must not be empty");
  return createHash("sha256").update(`muxpilot-app-server:${sessionId}`).digest("hex").slice(0, 24);
}
