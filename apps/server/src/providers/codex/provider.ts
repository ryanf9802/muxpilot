import { join } from "node:path";
import type { ProviderCapabilities, ProviderCompatibility } from "@muxpilot/core";
import type { AppDatabase } from "../../db/database.js";
import type { EventBus } from "../../services/eventBus.js";
import { sessionRuntimeCapabilityId } from "../../runtime/capabilityId.js";
import { ProtocolJournal, protocolJournalPath } from "../../runtime/protocolJournal.js";
import { shellQuote, SystemdSessionSupervisor } from "../../runtime/systemdSessionSupervisor.js";
import { ProjectionReconciler } from "../shared/projectionReconciler.js";
import type { AgentProvider, AgentSessionDriver, McpServerLaunchConfig, ProviderAuthGate } from "../types.js";
import { CodexAppServerConnectionManager } from "./connectionManager.js";
import { CodexAppServerDriver } from "./driver.js";
import { codexProjectionAdapter } from "./reconciler.js";

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  fastMode: true,
  reasoningEffort: true,
  planMode: true,
  steer: true,
  fork: true,
  btw: true,
  approvalReview: true,
  hibernate: true,
  terminalAttach: true,
  resetCredits: true,
  tokenUsageHistory: true,
  usageLimits: true,
  goals: true,
  backgroundTerminals: true,
  transcriptTransfer: true,
  imageInput: true,
  rawTranscriptEvidence: true
};

export interface CodexProviderOptions {
  compatibility: ProviderCompatibility;
  auth: ProviderAuthGate;
  dataDir: string;
  runtimeDir?: string;
  codexHome: string;
  environment: Record<string, string>;
  sessionEnvironment?: {
    resolveForLaunch(sessionId: string): Promise<{ environment: Record<string, string>; revision: number }>;
    markApplied(sessionId: string, revision?: number): Promise<void>;
  };
  db: AppDatabase;
  events: EventBus;
  onAuthenticationFailure?: (sessionId: string, error: string) => void;
  onAccountUpdated?: () => void;
  clientVersion?: string;
}

export function createCodexProvider(options: CodexProviderOptions): AgentProvider {
  return {
    kind: "codex",
    displayName: "Codex",
    capabilities: CODEX_CAPABILITIES,
    skillInvocation: { prefix: "$", position: "anywhere" },
    compatibility: () => options.compatibility,
    driver: createCodexDriver(options),
    auth: options.auth
  };
}

/** Builds side-effect-free app-server services; no process starts until a driver launch is requested. */
export function createCodexDriver(options: CodexProviderOptions): AgentSessionDriver | null {
  if (!options.compatibility.available) return null;
  if (!options.runtimeDir?.trim()) throw new Error("App-server runtime requires XDG_RUNTIME_DIR");
  const capabilityNamespace = options.environment.MUXPILOT_SHADOW === "1" ? "shadow" : "default";
  const capabilityId = (sessionId: string) => sessionRuntimeCapabilityId(sessionId, capabilityNamespace);

  const runtimeRoot = join(options.dataDir, "runtime", "app-server-sessions");
  const socketRoot = join(options.runtimeDir, "muxpilot", "app-server-sessions");
  const journalRoot = join(options.dataDir, "protocol", "app-server-sessions");
  const journals = new Map<string, ProtocolJournal>();
  const environmentLaunchRevisions = new Map<string, number>();
  const supervisor = new SystemdSessionSupervisor(runtimeRoot, {}, {
    socketRoot,
    legacySocketRoots: [runtimeRoot],
    attachmentCommand: (runtime) => `codex --remote ${shellQuote(`unix://${runtime.socketPath}`)}`
  });
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
  const reconciler = new ProjectionReconciler(
    options.db,
    options.events,
    codexProjectionAdapter,
    options.onAuthenticationFailure,
    options.onAccountUpdated
  );
  return new CodexAppServerDriver(supervisor, connections, {
    requestStore: options.db,
    processStore: options.db,
    eventSink: reconciler,
    runtimeSpec: async (spec) => {
      const sessionEnvironment = await options.sessionEnvironment?.resolveForLaunch(spec.sessionId);
      if (sessionEnvironment) environmentLaunchRevisions.set(spec.sessionId, sessionEnvironment.revision);
      const mcpServers = spec.options.mcpServers ?? [];
      return {
        sessionId: spec.sessionId,
        capabilityId: capabilityId(spec.sessionId),
        cwd: spec.cwd,
        agentVersion: options.compatibility.version,
        command: ({ socketPath }) => codexRuntimeCommand(socketPath, mcpServers),
        environment: {
          ...options.environment,
          ...(spec.options.environment ?? {}),
          ...(sessionEnvironment?.environment ?? {}),
          ...(options.environment.MUXPILOT_SHADOW === "1" ? { MUXPILOT_SHADOW: "1" } : {}),
          CODEX_HOME: options.codexHome
        },
        mcpServers
      };
    },
    runtimeStarted: async (sessionId, launchDisposition) => {
      const revision = environmentLaunchRevisions.get(sessionId);
      environmentLaunchRevisions.delete(sessionId);
      if (launchDisposition === "started") await options.sessionEnvironment?.markApplied(sessionId, revision);
    }
  });
}

export function codexRuntimeCommand(socketPath: string, mcpServers: McpServerLaunchConfig[]): string[] {
  const configArgs = [
    "-c", "check_for_update_on_startup=false",
    "-c", "sandbox_workspace_write.network_access=true"
  ];
  for (const server of mcpServers) {
    configArgs.push(
      "-c", `mcp_servers.${server.name}.command=${JSON.stringify(server.command)}`,
      "-c", `mcp_servers.${server.name}.args=${JSON.stringify(server.args)}`
    );
    if (server.defaultToolsApprovalMode) {
      configArgs.push(
        "-c",
        `mcp_servers.${server.name}.default_tools_approval_mode=${JSON.stringify(server.defaultToolsApprovalMode)}`
      );
    }
  }
  return ["codex", ...configArgs, "app-server", "--listen", `unix://${socketPath}`];
}
