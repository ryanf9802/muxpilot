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
  const capabilityNamespace = options.environment.MUXPILOT_SHADOW === "1" ? "shadow" : "default";
  const capabilityId = (sessionId: string) => appServerCapabilityId(sessionId, capabilityNamespace);

  const runtimeRoot = join(options.dataDir, "runtime", "app-server-sessions");
  const journalRoot = join(options.dataDir, "protocol", "app-server-sessions");
  const journals = new Map<string, ProtocolJournal>();
  const supervisor = new SystemdAppServerSupervisor(runtimeRoot);
  const connections = new CodexAppServerConnectionManager(
    supervisor,
    (sessionId) => {
      const existing = journals.get(sessionId);
      if (existing) return existing;
      const journal = new ProtocolJournal(protocolJournalPath(journalRoot, capabilityId(sessionId)));
      journals.set(sessionId, journal);
      return journal;
    },
    options.clientVersion ?? "muxpilot/0.1.0"
  );
  const reconciler = new CodexAppServerReconciler(options.db, options.events);
  registry.register(new CodexAppServerDriver(supervisor, connections, {
    requestStore: options.db,
    processStore: options.db,
    eventSink: reconciler,
    runtimeSpec: (spec) => ({
      sessionId: spec.sessionId,
      capabilityId: capabilityId(spec.sessionId),
      cwd: spec.cwd,
      codexHome: options.codexHome,
      codexVersion: options.compatibility.codexVersion,
      environment: {
        ...options.environment,
        ...(spec.options.environment ?? {}),
        ...(options.environment.MUXPILOT_SHADOW === "1" ? { MUXPILOT_SHADOW: "1" } : {})
      },
      mcpServers: spec.options.mcpServers ?? []
    })
  }));
  return registry;
}

export function appServerCapabilityId(sessionId: string, namespace = "default"): string {
  if (!sessionId.trim()) throw new Error("App-server session id must not be empty");
  if (!namespace.trim()) throw new Error("App-server capability namespace must not be empty");
  const prefix = namespace === "default" ? "muxpilot-app-server" : `muxpilot-app-server:${namespace}`;
  return createHash("sha256").update(`${prefix}:${sessionId}`).digest("hex").slice(0, 24);
}
