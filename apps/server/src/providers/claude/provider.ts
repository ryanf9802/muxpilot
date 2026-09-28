import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderCapabilities } from "@muxpilot/core";
import type { AppDatabase } from "../../db/database.js";
import type { EventBus } from "../../services/eventBus.js";
import { muxpilotGitWorkflowSkillStatus, syncMuxpilotGitWorkflowSkill } from "../../services/bundledSkills.js";
import { discoverSkills, type SkillDiscoverySources } from "../../services/skillDiscovery.js";
import { sessionRuntimeCapabilityId } from "../../runtime/capabilityId.js";
import { ProtocolJournal, protocolJournalPath } from "../../runtime/protocolJournal.js";
import { SystemdSessionSupervisor } from "../../runtime/systemdSessionSupervisor.js";
import { openUnixJsonLineConnection } from "../../runtime/unixJsonLineConnection.js";
import { ProjectionReconciler } from "../shared/projectionReconciler.js";
import type { AgentProvider, AgentSessionDriver, AgentSessionLaunchOptions, ProviderTranscriptSource } from "../types.js";
import { ClaudeApprovalReviewer } from "./approvalReviewer.js";
import { eventId } from "../../utils/ids.js";
import { ClaudeBtwEngine } from "./btw.js";
import { ClaudeTranscriptArchive } from "./transcriptArchive.js";
import { ClaudeAuthLifecycle, claudeCommandRunner } from "./auth.js";
import type { ClaudeCompatibility } from "./compatibility.js";
import { ClaudeSessionDriver } from "./driver.js";
import { claudeProjectionAdapter } from "./events.js";
import { claudeRuntimeEnvironment } from "./host/claudeHost.js";
import type { QueryFactory } from "./host/hostSession.js";
import { claudeProjectSlug, type HostLaunchConfig } from "./host/protocol.js";
import { CLAUDE_PARSER_VERSION, parseClaudeJsonl } from "./transcript.js";
import { ClaudeControlClient, ClaudeModelsService, ClaudeTokenHistory, ClaudeUsageService } from "./usage.js";

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  fastMode: true,
  reasoningEffort: true,
  planMode: true,
  steer: true,
  fork: true,
  btw: true,
  approvalReview: true,
  hibernate: true,
  terminalAttach: false,
  resetCredits: false,
  tokenUsageHistory: true,
  usageLimits: true,
  goals: false,
  backgroundTerminals: true,
  transcriptTransfer: true,
  imageInput: true,
  rawTranscriptEvidence: true,
  nativeAgents: true
};

export function claudeTranscripts(configDir: string, archive?: ClaudeTranscriptArchive): ProviderTranscriptSource {
  return {
    parserVersion: CLAUDE_PARSER_VERSION,
    parse: (path, offset, context) => parseClaudeJsonl(path, offset, context),
    importPath: (threadId, cwd) => join(configDir, "projects", claudeProjectSlug(cwd), `${threadId}.jsonl`),
    ...(archive
      ? {
          ensureAvailable: async (provider) => {
            await archive.ensureRestored(provider.threadId, provider.transcriptPath);
          },
          preserve: (provider) => archive.mirror(provider.threadId, provider.transcriptPath)
        }
      : {})
  };
}

const PLUGIN_NAME = "muxpilot";

export interface ClaudeProviderOptions {
  compatibility: ClaudeCompatibility;
  dataDir: string;
  runtimeDir?: string;
  /** Claude Code configuration directory (`CLAUDE_CONFIG_DIR`, default `~/.claude`). */
  configDir: string;
  /** Root holding bundled muxpilot skills for helper-script paths (`<skillHome>/skills/<name>`). */
  skillHome?: string;
  environment: Record<string, string>;
  sessionEnvironment?: {
    resolveForLaunch(sessionId: string): Promise<{ environment: Record<string, string>; revision: number }>;
    markApplied(sessionId: string, revision?: number): Promise<void>;
  };
  db: AppDatabase;
  events: EventBus;
  logger?: Pick<Logger, "warn" | "debug" | "info">;
  queryFactory?: QueryFactory;
  clientVersion?: string;
}

export interface ClaudeProvider extends AgentProvider {
  readonly authLifecycle: ClaudeAuthLifecycle;
  readonly usage: ClaudeUsageService;
  readonly models: ClaudeModelsService;
  readonly approvalReview: ClaudeApprovalReviewer;
  readonly archive: ClaudeTranscriptArchive;
  /** Installs the bundled muxpilot skills as a local Claude plugin owned by muxpilot. */
  syncBundledSkills(): Promise<void>;
}

export function createClaudeProvider(options: ClaudeProviderOptions): ClaudeProvider {
  const queryFactory = options.queryFactory ?? ((params) => query(params));
  const claudePath = options.compatibility.claudePath ?? "claude";
  const cliEnvironment = { ...claudeRuntimeEnvironment(process.env), CLAUDE_CONFIG_DIR: options.configDir };
  const pluginRoot = join(options.dataDir, "claude-plugin", PLUGIN_NAME);
  const archive = new ClaudeTranscriptArchive(join(options.dataDir, "claude-archive"), options.logger);
  const control = new ClaudeControlClient({
    claudePath,
    configDir: options.configDir,
    environment: cliEnvironment,
    workDir: join(options.dataDir, "runtime", "claude-control"),
    queryFactory,
    logger: options.logger
  });
  const usage = new ClaudeUsageService(control, new ClaudeTokenHistory(join(options.configDir, "projects")));
  const authLifecycle = new ClaudeAuthLifecycle(
    options.db,
    options.events,
    options.configDir,
    claudeCommandRunner(claudePath, cliEnvironment),
    options.logger
  );
  const skillSources: SkillDiscoverySources = {
    homeSkillRoots: [join(options.configDir, "skills")],
    pluginSearchRoots: [join(options.configDir, "plugins"), join(options.dataDir, "claude-plugin")],
    pluginManifestPath: join(".claude-plugin", "plugin.json"),
    workspaceSkillDirs: [join(".claude", "skills")]
  };
  return {
    kind: "claude",
    displayName: "Claude",
    capabilities: CLAUDE_CAPABILITIES,
    skillInvocation: { prefix: "/", position: "start" },
    compatibility: () => options.compatibility,
    driver: createClaudeDriver(options, {
      claudePath,
      pluginRoot,
      onAuthenticationFailure: (_sessionId, error) => authLifecycle.reportAuthenticationFailure(error),
      onRateLimit: (info) => usage.observeRateLimit(info),
      archive
    }),
    auth: authLifecycle,
    authLifecycle,
    usage,
    models: new ClaudeModelsService(control),
    skills: {
      discover: (workspaceRoots) => discoverSkills(skillSources, workspaceRoots),
      gitWorkflowSkillStatus: () => muxpilotGitWorkflowSkillStatus(pluginRoot)
    },
    transcripts: claudeTranscripts(options.configDir, archive),
    archive,
    approvalReview: new ClaudeApprovalReviewer({ claudePath, configDir: options.configDir, environment: cliEnvironment, queryFactory, archive, logger: options.logger }),
    defaultReviewerSettings: { model: "haiku", reasoningEffort: null },
    btw: new ClaudeBtwEngine({ claudePath, configDir: options.configDir, environment: cliEnvironment, queryFactory, archive, logger: options.logger }),
    syncBundledSkills: async () => {
      await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
      await writeFile(join(pluginRoot, ".claude-plugin", "plugin.json"), `${JSON.stringify({
        name: PLUGIN_NAME,
        description: "muxpilot Git workflow, heavy-command queue, session orchestration and documents skills",
        version: "1.0.0"
      }, null, 2)}\n`);
      await syncMuxpilotGitWorkflowSkill(pluginRoot);
    }
  };
}

interface ClaudeDriverContext {
  claudePath: string;
  pluginRoot: string;
  onAuthenticationFailure(sessionId: string, error: string): void;
  onRateLimit(info: Record<string, unknown>): void;
  archive: ClaudeTranscriptArchive;
}

function createClaudeDriver(options: ClaudeProviderOptions, context: ClaudeDriverContext): AgentSessionDriver | null {
  if (!options.compatibility.available) return null;
  if (!options.runtimeDir?.trim()) throw new Error("Claude runtime requires XDG_RUNTIME_DIR");
  const capabilityNamespace = options.environment.MUXPILOT_SHADOW === "1" ? "shadow" : "default";
  const capabilityId = (sessionId: string) => sessionRuntimeCapabilityId(sessionId, capabilityNamespace);
  const runtimeRoot = join(options.dataDir, "runtime", "claude-sessions");
  const journalRoot = join(options.dataDir, "protocol", "claude-sessions");
  const journals = new Map<string, ProtocolJournal>();
  const environmentLaunchRevisions = new Map<string, number>();
  const supervisor = new SystemdSessionSupervisor(runtimeRoot, {
    openProxy: (socketPath) => openUnixJsonLineConnection(socketPath)
  }, {
    socketRoot: join(options.runtimeDir, "muxpilot", "claude-sessions")
  });
  const reconciler = new ProjectionReconciler(options.db, options.events, claudeProjectionAdapter, context.onAuthenticationFailure);
  const hostCommand = claudeHostCommand();
  return new ClaudeSessionDriver(supervisor, {
    requestStore: options.db,
    eventSink: reconciler,
    onRateLimit: context.onRateLimit,
    archive: context.archive,
    onAgentsChanged: (sessionId, agents) => options.events.publish({
      id: eventId(),
      type: "session.agents.updated",
      sessionId,
      payload: { agents },
      timestamp: new Date().toISOString()
    }),
    clientVersion: options.clientVersion,
    journalFor: (sessionId) => {
      const existing = journals.get(sessionId);
      if (existing) return existing;
      const journal = new ProtocolJournal(protocolJournalPath(journalRoot, capabilityId(sessionId)));
      journals.set(sessionId, journal);
      return journal;
    },
    hostLaunch: ({ cwd, options: launch }) => claudeHostLaunch(cwd, launch, context, options.environment),
    runtimeSpec: async (spec) => {
      const sessionEnvironment = await options.sessionEnvironment?.resolveForLaunch(spec.sessionId);
      if (sessionEnvironment) environmentLaunchRevisions.set(spec.sessionId, sessionEnvironment.revision);
      return {
        sessionId: spec.sessionId,
        capabilityId: capabilityId(spec.sessionId),
        cwd: spec.cwd,
        agentVersion: options.compatibility.version,
        command: ({ socketPath, directory }) => [
          ...hostCommand,
          "--socket", socketPath,
          "--state-dir", directory,
          "--config-dir", options.configDir
        ],
        environment: {
          ...options.environment,
          ...(spec.options.environment ?? {}),
          ...(sessionEnvironment?.environment ?? {}),
          CLAUDE_CONFIG_DIR: options.configDir,
          DISABLE_AUTOUPDATER: "1"
        },
        mcpServers: spec.options.mcpServers ?? []
      };
    },
    runtimeStarted: async (sessionId, launchDisposition) => {
      const revision = environmentLaunchRevisions.get(sessionId);
      environmentLaunchRevisions.delete(sessionId);
      if (launchDisposition === "started") await options.sessionEnvironment?.markApplied(sessionId, revision);
    }
  });
}

function claudeHostLaunch(
  cwd: string,
  launch: AgentSessionLaunchOptions,
  context: ClaudeDriverContext,
  managedEnvironment: Record<string, string>
): HostLaunchConfig {
  const environment = { ...managedEnvironment, ...(launch.environment ?? {}) };
  const unixSockets = [
    environment.MUXPILOT_GIT_BROKER_SOCKET,
    environment.MUXPILOT_HEAVY_BROKER_SOCKET,
    environment.DOCKER_HOST?.startsWith("unix://") ? environment.DOCKER_HOST.slice("unix://".length) : undefined
  ].filter((value): value is string => Boolean(value));
  return {
    model: launch.model && launch.model !== "default" ? launch.model : null,
    effort: launch.reasoningEffort ?? null,
    fastMode: launch.fastMode ?? null,
    permissionMode: "default",
    systemPromptAppend: launch.developerInstructions ? adaptInstructionsForClaude(launch.developerInstructions) : null,
    mcpServers: (launch.mcpServers ?? []).map(({ name, command, args }) => ({ name, command, args })),
    writableRoots: [...new Set([cwd, ...(launch.writableRoots ?? [])])],
    allowUnixSockets: unixSockets,
    settingSources: ["user", "project", "local"],
    pluginDirs: [context.pluginRoot],
    claudePath: context.claudePath
  };
}

/**
 * muxpilot's shared session instructions use Codex conventions (`$skill-name` references and Codex subagents);
 * rewrite them for Claude Code, whose skills are invoked by name and whose subagents run through the Task tool.
 */
export function adaptInstructionsForClaude(text: string): string {
  return text
    .replace(/\$(muxpilot-[a-z0-9-]+)/g, "the $1 skill")
    .replace(/\$skill-name/g, "/skill-name")
    .replace(/built-in Codex subagents/g, "Claude's built-in subagents (the Agent tool)")
    // Claude Code runs durable and parallel work natively as background subagents, which muxpilot shows in its
    // Agents view; nested muxpilot sessions are only for explicit operator requests.
    .replace(
      /the work is durable and benefits from independent monitoring and its own resource scope/g,
      "a child must run on a different provider. Run long-running or parallel work as Claude background subagents instead; the operator watches and stops them in muxpilot's Agents view"
    )
    .replace(/Codex subagents/g, "Claude subagents")
    .replace(/Codex file evidence/g, "Claude transcript evidence");
}

/** Node argv that runs the Claude host from built output, or from TypeScript sources in development. */
function claudeHostCommand(): string[] {
  const compiled = import.meta.url.endsWith(".js");
  const entry = fileURLToPath(new URL(`./host/claudeHostMain.${compiled ? "js" : "ts"}`, import.meta.url));
  if (compiled) return [process.execPath, entry];
  const loader = createRequire(import.meta.url).resolve("tsx");
  return [process.execPath, "--import", `file://${loader}`, entry];
}
