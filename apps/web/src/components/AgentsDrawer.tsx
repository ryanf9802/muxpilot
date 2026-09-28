import {
  Activity,
  ArrowLeft,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock3,
  LoaderCircle,
  Pause,
  Square,
  SquareTerminal,
  Workflow
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, SessionAgent, SessionAgentMessagesResponse } from "@muxpilot/core";
import { ApiError } from "../api/client.js";
import { Modal } from "./Modal.js";

/** How often an open, still-running subagent transcript is refreshed. */
export const AGENT_TRANSCRIPT_REFRESH_MS = 3000;

export interface AgentGroups {
  running: SessionAgent[];
  finished: SessionAgent[];
  hiddenAmbient: number;
}

export function isAgentActive(agent: Pick<SessionAgent, "status">): boolean {
  return agent.status === "running" || agent.status === "paused";
}

/** Splits agents into Running (running/paused) and Finished, newest first, hiding housekeeping unless asked. */
export function groupSessionAgents(agents: readonly SessionAgent[], showAmbient: boolean): AgentGroups {
  const visible = showAmbient ? [...agents] : agents.filter((agent) => !agent.ambient);
  visible.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return {
    running: visible.filter(isAgentActive),
    finished: visible.filter((agent) => !isAgentActive(agent)),
    hiddenAmbient: showAmbient ? 0 : agents.length - visible.length
  };
}

/** Running (non-housekeeping) agents, for the toolbar badge. */
export function runningAgentCount(agents: readonly SessionAgent[]): number {
  return agents.filter((agent) => !agent.ambient && isAgentActive(agent)).length;
}

/** The agent a transcript tool call started, when the call is an Agent/Task tool use. */
export function agentForToolCall(message: Pick<ChatMessage, "type" | "payload">, agents: readonly SessionAgent[]): SessionAgent | null {
  if (message.type !== "tool_call" || agents.length === 0) return null;
  const payload = message.payload as Record<string, unknown> | null | undefined;
  const toolName = payload?.toolName;
  const toolUseId = payload?.toolUseId;
  if (toolName !== "Agent" && toolName !== "Task") return null;
  if (typeof toolUseId !== "string" || !toolUseId) return null;
  return agents.find((agent) => agent.toolUseId === toolUseId) ?? null;
}

export function sessionAgentsErrorMessage(error: unknown, fallback = "Unable to load agents"): string {
  if (error instanceof ApiError && error.status === 409) return "This session's provider doesn't expose native agents.";
  return error instanceof Error && error.message ? error.message : fallback;
}

export function agentKindLabel(kind: SessionAgent["kind"]): string {
  if (kind === "subagent") return "Subagent";
  if (kind === "shell") return "Shell";
  if (kind === "monitor") return "Monitor";
  if (kind === "workflow") return "Workflow";
  return "Task";
}

export function agentStatusLabel(status: SessionAgent["status"]): string {
  if (status === "running") return "Running";
  if (status === "paused") return "Paused";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Stopped";
}

export function formatAgentDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function formatAgentTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatAgentStartedAt(value: string, nowMs = Date.now()): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((nowMs - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(time));
}

function agentUsageLabel(usage: SessionAgent["usage"]): string | null {
  if (!usage) return null;
  const toolUses = `${usage.toolUses} ${usage.toolUses === 1 ? "tool use" : "tool uses"}`;
  return `${formatAgentTokens(usage.totalTokens)} tokens · ${toolUses} · ${formatAgentDuration(usage.durationMs)}`;
}

function AgentKindIcon({ kind }: { kind: SessionAgent["kind"] }) {
  if (kind === "subagent") return <Bot size={14} />;
  if (kind === "shell") return <SquareTerminal size={14} />;
  if (kind === "monitor") return <Activity size={14} />;
  if (kind === "workflow") return <Workflow size={14} />;
  return <CircleDot size={14} />;
}

function AgentStatusIcon({ status }: { status: SessionAgent["status"] }) {
  if (status === "running") return <LoaderCircle className="spin" size={12} />;
  if (status === "paused") return <Pause size={12} />;
  if (status === "completed") return <CircleCheck size={12} />;
  if (status === "failed") return <CircleAlert size={12} />;
  return <Clock3 size={12} />;
}

export function AgentsDrawer({
  open,
  agents,
  loading,
  error,
  selectedAgentId,
  onSelectAgent,
  onClose,
  loadMessages,
  onStop,
  renderMessage
}: {
  open: boolean;
  agents: SessionAgent[];
  loading: boolean;
  error: string;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onClose: () => void;
  loadMessages: (agentId: string) => Promise<SessionAgentMessagesResponse>;
  onStop: (agentId: string) => Promise<void>;
  /** Renders one transcript message; SessionView passes its own transcript renderer. */
  renderMessage: (message: ChatMessage) => ReactNode;
}) {
  const [showAmbient, setShowAmbient] = useState(false);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({});

  if (!open) return null;

  const selectedFromList = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) ?? null : null;

  async function stopAgent(agentId: string) {
    if (stopping.has(agentId)) return;
    setStopping((current) => new Set(current).add(agentId));
    setStopErrors(({ [agentId]: _previous, ...rest }) => rest);
    try {
      await onStop(agentId);
    } catch (stopError) {
      setStopErrors((current) => ({
        ...current,
        [agentId]: stopError instanceof Error && stopError.message ? stopError.message : "Unable to stop agent"
      }));
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(agentId);
        return next;
      });
    }
  }

  const stopControls = (agent: SessionAgent) => ({
    stopping: stopping.has(agent.id),
    stopError: stopErrors[agent.id] ?? "",
    onStop: () => void stopAgent(agent.id)
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Agents"
      panelClassName="btw-drawer agents-drawer"
      backdropClassName="btw-drawer-backdrop"
      closeLabel="Close agents drawer"
      placement="end"
    >
      {selectedAgentId ? (
        <AgentTranscript
          key={selectedAgentId}
          agentId={selectedAgentId}
          liveAgent={selectedFromList}
          loadMessages={loadMessages}
          renderMessage={renderMessage}
          onBack={() => onSelectAgent(null)}
          stopControls={stopControls}
        />
      ) : (
        <AgentList
          agents={agents}
          loading={loading}
          error={error}
          showAmbient={showAmbient}
          onToggleAmbient={() => setShowAmbient((current) => !current)}
          onSelectAgent={onSelectAgent}
          stopControls={stopControls}
        />
      )}
    </Modal>
  );
}

type StopControls = (agent: SessionAgent) => { stopping: boolean; stopError: string; onStop: () => void };

function AgentList({
  agents,
  loading,
  error,
  showAmbient,
  onToggleAmbient,
  onSelectAgent,
  stopControls
}: {
  agents: SessionAgent[];
  loading: boolean;
  error: string;
  showAmbient: boolean;
  onToggleAmbient: () => void;
  onSelectAgent: (agentId: string) => void;
  stopControls: StopControls;
}) {
  const groups = groupSessionAgents(agents, showAmbient);
  const hasAmbient = agents.some((agent) => agent.ambient);
  const empty = groups.running.length === 0 && groups.finished.length === 0;
  return (
    <>
      <div className="btw-drawer-intro">
        <p className="btw-drawer-description">Subagents and background tasks this session's agent started.</p>
        {hasAmbient ? (
          <label className="agents-ambient-toggle">
            <input type="checkbox" checked={showAmbient} onChange={onToggleAmbient} />
            <span>Show housekeeping tasks</span>
          </label>
        ) : null}
      </div>
      <div className="btw-exchange-list agents-list" role="region" aria-label="Session agents" aria-live="polite">
        {error ? <p className="btw-error btw-drawer-error" role="alert"><CircleAlert size={15} /> <span>{error}</span></p> : null}
        {loading && agents.length === 0 ? (
          <div className="btw-empty">
            <LoaderCircle className="spin" size={16} />
            <span>Loading agents…</span>
          </div>
        ) : null}
        {!loading && !error && empty ? (
          <div className="btw-empty">
            <span>No subagents or background tasks yet.</span>
          </div>
        ) : null}
        {groups.running.length > 0 ? (
          <AgentGroup title="Running" agents={groups.running} onSelectAgent={onSelectAgent} stopControls={stopControls} />
        ) : null}
        {groups.finished.length > 0 ? (
          <AgentGroup title="Finished" agents={groups.finished} onSelectAgent={onSelectAgent} stopControls={stopControls} />
        ) : null}
      </div>
    </>
  );
}

function AgentGroup({
  title,
  agents,
  onSelectAgent,
  stopControls
}: {
  title: string;
  agents: SessionAgent[];
  onSelectAgent: (agentId: string) => void;
  stopControls: StopControls;
}) {
  return (
    <section className="agents-group" aria-label={`${title} agents`}>
      <div className="btw-history-heading">
        <strong>{title}</strong>
        <span>{agents.length}</span>
      </div>
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} onSelect={agent.kind === "subagent" ? () => onSelectAgent(agent.id) : null} {...stopControls(agent)} />
      ))}
    </section>
  );
}

function AgentRow({
  agent,
  onSelect,
  stopping,
  stopError,
  onStop
}: {
  agent: SessionAgent;
  onSelect: (() => void) | null;
  stopping: boolean;
  stopError: string;
  onStop: () => void;
}) {
  const body = <AgentSummary agent={agent} />;
  return (
    <article className="btw-exchange agents-row" data-status={agent.status} data-kind={agent.kind}>
      {onSelect ? (
        <button type="button" className="agents-row-main" onClick={onSelect} aria-label={`Open ${agentKindLabel(agent.kind).toLowerCase()} transcript: ${agent.description}`}>
          {body}
          <ChevronRight className="agents-row-chevron" size={16} />
        </button>
      ) : (
        <div className="agents-row-main">{body}</div>
      )}
      <AgentActions agent={agent} stopping={stopping} stopError={stopError} onStop={onStop} />
    </article>
  );
}

function AgentSummary({ agent }: { agent: SessionAgent }) {
  const usage = agentUsageLabel(agent.usage);
  return (
    <span className="agents-row-body">
      <span className="agents-row-heading">
        <span className="agents-kind"><AgentKindIcon kind={agent.kind} /> {agentKindLabel(agent.kind)}</span>
        {agent.agentType ? <span className="agents-type-badge">{agent.agentType}</span> : null}
        {agent.ambient ? <span className="agents-type-badge">Housekeeping</span> : null}
        <span className="btw-status agents-status"><AgentStatusIcon status={agent.status} /> {agentStatusLabel(agent.status)}</span>
      </span>
      <span className="agents-description">{agent.description || "Untitled task"}</span>
      {agent.error ? (
        <span className="btw-error agents-detail"><CircleAlert size={13} /> <span>{agent.error}</span></span>
      ) : agent.summary && agent.summary !== agent.description ? (
        <span className="agents-summary">{agent.summary}</span>
      ) : null}
      <span className="agents-meta">
        {agent.lastToolName ? <span>Last tool: {agent.lastToolName}</span> : null}
        {usage ? <span>{usage}</span> : null}
        <time dateTime={agent.startedAt} title={new Date(agent.startedAt).toLocaleString()}>Started {formatAgentStartedAt(agent.startedAt)}</time>
      </span>
    </span>
  );
}

function AgentActions({ agent, stopping, stopError, onStop }: { agent: SessionAgent; stopping: boolean; stopError: string; onStop: () => void }) {
  if (!isAgentActive(agent) && !stopError) return null;
  return (
    <div className="agents-row-actions">
      {stopError ? <p className="btw-error" role="alert"><CircleAlert size={13} /> <span>{stopError}</span></p> : null}
      {isAgentActive(agent) ? (
        <div className="btw-exchange-actions">
          <button
            type="button"
            className="btw-action-button btw-cancel-button"
            disabled={stopping}
            aria-busy={stopping}
            aria-label={`Stop ${agent.description || agentKindLabel(agent.kind)}`}
            onClick={onStop}
          >
            {stopping ? <LoaderCircle className="spin" size={13} /> : <Square size={13} />} {stopping ? "Stopping" : "Stop"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AgentTranscript({
  agentId,
  liveAgent,
  loadMessages,
  renderMessage,
  onBack,
  stopControls
}: {
  agentId: string;
  liveAgent: SessionAgent | null;
  loadMessages: (agentId: string) => Promise<SessionAgentMessagesResponse>;
  renderMessage: (message: ChatMessage) => ReactNode;
  onBack: () => void;
  stopControls: StopControls;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [fetchedAgent, setFetchedAgent] = useState<SessionAgent | null>(null);
  const [error, setError] = useState("");
  const loadMessagesRef = useRef(loadMessages);
  loadMessagesRef.current = loadMessages;
  const agent = liveAgent ?? fetchedAgent;
  const active = agent ? isAgentActive(agent) : true;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await loadMessagesRef.current(agentId);
        if (cancelled) return;
        setMessages(response.messages);
        setFetchedAgent(response.agent);
        setError("");
      } catch (loadError) {
        if (!cancelled) setError(sessionAgentsErrorMessage(loadError, "Unable to load agent transcript"));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const interval = active ? window.setInterval(() => void refresh(), AGENT_TRANSCRIPT_REFRESH_MS) : null;
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [agentId, active]);

  return (
    <>
      <div className="btw-drawer-intro agents-transcript-head">
        <button type="button" className="btw-action-button agents-back-button" onClick={onBack}>
          <ArrowLeft size={13} /> All agents
        </button>
        {agent ? (
          <div className="btw-exchange agents-row" data-status={agent.status} data-kind={agent.kind}>
            <div className="agents-row-main"><AgentSummary agent={agent} /></div>
            <AgentActions agent={agent} {...stopControls(agent)} />
          </div>
        ) : null}
      </div>
      <div className="btw-exchange-list agents-transcript" role="region" aria-label="Agent transcript" aria-live="polite">
        {error ? <p className="btw-error btw-drawer-error" role="alert"><CircleAlert size={15} /> <span>{error}</span></p> : null}
        {messages === null && !error ? (
          <div className="btw-empty">
            <LoaderCircle className="spin" size={16} />
            <span>Loading transcript…</span>
          </div>
        ) : null}
        {messages !== null && messages.length === 0 ? (
          <div className="btw-empty">
            <span>{active ? "Waiting for the agent's first message…" : "This agent has no transcript."}</span>
          </div>
        ) : null}
        {messages?.map((message) => <div key={message.id} className="agents-transcript-message">{renderMessage(message)}</div>)}
      </div>
    </>
  );
}
