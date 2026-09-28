// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage, SessionAgent, SessionAgentMessagesResponse } from "@muxpilot/core";
import { ApiError } from "../api/client.js";
import {
  AGENT_TRANSCRIPT_REFRESH_MS,
  agentForToolCall,
  AgentsDrawer,
  formatAgentDuration,
  formatAgentTokens,
  groupSessionAgents,
  runningAgentCount,
  sessionAgentsErrorMessage
} from "./AgentsDrawer.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("agent helpers", () => {
  it("groups running agents before finished ones, newest first, hiding housekeeping by default", () => {
    const agents = [
      agent({ id: "old-done", status: "completed", startedAt: "2026-09-27T10:00:00.000Z" }),
      agent({ id: "old-run", status: "running", startedAt: "2026-09-27T10:01:00.000Z" }),
      agent({ id: "new-paused", status: "paused", startedAt: "2026-09-27T10:05:00.000Z" }),
      agent({ id: "new-failed", status: "failed", startedAt: "2026-09-27T10:06:00.000Z" }),
      agent({ id: "ambient", status: "running", ambient: true, startedAt: "2026-09-27T10:07:00.000Z" })
    ];
    const hidden = groupSessionAgents(agents, false);
    expect(hidden.running.map((item) => item.id)).toEqual(["new-paused", "old-run"]);
    expect(hidden.finished.map((item) => item.id)).toEqual(["new-failed", "old-done"]);
    expect(hidden.hiddenAmbient).toBe(1);
    expect(groupSessionAgents(agents, true).running.map((item) => item.id)).toEqual(["ambient", "new-paused", "old-run"]);
    expect(runningAgentCount(agents)).toBe(2);
  });

  it("links Agent/Task tool calls to the agent they started", () => {
    const agents = [agent({ id: "a1", toolUseId: "toolu_1" })];
    expect(agentForToolCall(toolCall("Agent", "toolu_1"), agents)?.id).toBe("a1");
    expect(agentForToolCall(toolCall("Task", "toolu_1"), agents)?.id).toBe("a1");
    expect(agentForToolCall(toolCall("Bash", "toolu_1"), agents)).toBeNull();
    expect(agentForToolCall(toolCall("Agent", "toolu_2"), agents)).toBeNull();
  });

  it("formats usage and maps unsupported-provider errors", () => {
    expect(formatAgentDuration(4_200)).toBe("4s");
    expect(formatAgentDuration(125_000)).toBe("2m 5s");
    expect(formatAgentDuration(3_900_000)).toBe("1h 5m");
    expect(formatAgentTokens(950)).toBe("950");
    expect(formatAgentTokens(12_345)).toBe("12k");
    expect(formatAgentTokens(1_500)).toBe("1.5k");
    expect(sessionAgentsErrorMessage(new ApiError("nope", 409))).toContain("doesn't expose native agents");
    expect(sessionAgentsErrorMessage(new Error("boom"))).toBe("boom");
  });
});

describe("AgentsDrawer", () => {
  it("lists running and finished groups and toggles housekeeping tasks", () => {
    const { container, root } = mount();
    render(root, {
      agents: [
        agent({ id: "run", description: "Explore the repo", status: "running", agentType: "Explore", summary: "Reading files", lastToolName: "Grep", usage: { totalTokens: 12_345, toolUses: 3, durationMs: 65_000 } }),
        agent({ id: "done", kind: "shell", description: "npm test", status: "failed", error: "exit 1", startedAt: "2026-09-27T09:00:00.000Z" }),
        agent({ id: "house", description: "Summarize memory", ambient: true })
      ]
    });
    const groups = Array.from(container.querySelectorAll(".agents-group")).map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Running agents", "Finished agents"]);
    expect(container.textContent).toContain("Explore the repo");
    expect(container.textContent).toContain("Explore");
    expect(container.textContent).toContain("Reading files");
    expect(container.textContent).toContain("Last tool: Grep");
    expect(container.textContent).toContain("12k tokens · 3 tool uses · 1m 5s");
    expect(container.textContent).toContain("Shell");
    expect(container.textContent).toContain("exit 1");
    expect(container.textContent).not.toContain("Summarize memory");

    const toggle = container.querySelector(".agents-ambient-toggle input") as HTMLInputElement;
    act(() => toggle.click());
    expect(container.textContent).toContain("Summarize memory");
    act(() => root.unmount());
  });

  it("shows empty and error states", () => {
    const { container, root } = mount();
    render(root, { agents: [] });
    expect(container.textContent).toContain("No subagents or background tasks yet.");
    render(root, { agents: [], error: "This session's provider doesn't expose native agents." });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("doesn't expose native agents");
    expect(container.textContent).not.toContain("No subagents or background tasks yet.");
    act(() => root.unmount());
  });

  it("stops a running agent, disabling the button while pending and showing failures inline", async () => {
    let rejectStop: (error: Error) => void = () => undefined;
    const onStop = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectStop = reject; }));
    const { container, root } = mount();
    render(root, { agents: [agent({ id: "run", status: "running" })], onStop });
    const stop = container.querySelector(".btw-cancel-button") as HTMLButtonElement;
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledWith("run");
    expect((container.querySelector(".btw-cancel-button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      rejectStop(new Error("Agent already exited"));
      await Promise.resolve();
    });
    expect(container.querySelector(".agents-row-actions [role=alert]")?.textContent).toContain("Agent already exited");
    expect((container.querySelector(".btw-cancel-button") as HTMLButtonElement).disabled).toBe(false);
    act(() => root.unmount());
  });

  it("opens a subagent transcript with the supplied renderer and refreshes it while running", async () => {
    vi.useFakeTimers();
    const running = agent({ id: "sub", description: "Explore the repo", status: "running" });
    const loadMessages = vi.fn(async (): Promise<SessionAgentMessagesResponse> => ({
      agent: running,
      messages: [message("m1", "First finding")]
    }));
    const onSelectAgent = vi.fn();
    const { container, root } = mount();
    render(root, { agents: [running, agent({ id: "sh", kind: "shell", description: "npm test" })], onSelectAgent, loadMessages });

    expect(container.querySelectorAll("button.agents-row-main")).toHaveLength(1);
    act(() => (container.querySelector("button.agents-row-main") as HTMLButtonElement).click());
    expect(onSelectAgent).toHaveBeenCalledWith("sub");

    await act(async () => {
      render(root, { agents: [running], selectedAgentId: "sub", onSelectAgent, loadMessages });
      await Promise.resolve();
    });
    expect(loadMessages).toHaveBeenCalledWith("sub");
    expect(container.querySelector(".test-message")?.textContent).toBe("First finding");

    await act(async () => {
      vi.advanceTimersByTime(AGENT_TRANSCRIPT_REFRESH_MS);
      await Promise.resolve();
    });
    expect(loadMessages).toHaveBeenCalledTimes(2);

    act(() => (container.querySelector(".agents-back-button") as HTMLButtonElement).click());
    expect(onSelectAgent).toHaveBeenLastCalledWith(null);
    act(() => root.unmount());
  });

  it("stops polling finished transcripts and reports load failures", async () => {
    vi.useFakeTimers();
    const loadMessages = vi.fn(async (): Promise<SessionAgentMessagesResponse> => { throw new ApiError("gone", 404); });
    const { container, root } = mount();
    await act(async () => {
      render(root, { agents: [agent({ id: "sub", status: "completed" })], selectedAgentId: "sub", loadMessages });
      await Promise.resolve();
    });
    expect(container.querySelector("[role=alert]")?.textContent).toContain("gone");
    await act(async () => {
      vi.advanceTimersByTime(AGENT_TRANSCRIPT_REFRESH_MS * 3);
      await Promise.resolve();
    });
    expect(loadMessages).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, root: createRoot(container) };
}

function render(root: Root, props: Partial<Parameters<typeof AgentsDrawer>[0]> & { agents: SessionAgent[] }) {
  act(() => root.render(
    <AgentsDrawer
      open
      loading={false}
      error=""
      selectedAgentId={null}
      onSelectAgent={() => undefined}
      onClose={() => undefined}
      loadMessages={async () => ({ agent: null, messages: [] })}
      onStop={async () => undefined}
      renderMessage={(item) => <p className="test-message">{item.text}</p>}
      {...props}
    />
  ));
}

function agent(overrides: Partial<SessionAgent> = {}): SessionAgent {
  return {
    id: "agent-1",
    toolUseId: null,
    kind: "subagent",
    agentType: null,
    description: "Investigate",
    status: "completed",
    background: false,
    depth: 1,
    lastToolName: null,
    summary: null,
    error: null,
    usage: null,
    ambient: false,
    startedAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
    ...overrides
  };
}

function toolCall(toolName: string, toolUseId: string): Pick<ChatMessage, "type" | "payload"> {
  return { type: "tool_call", payload: { toolName, toolUseId } };
}

function message(id: string, text: string): ChatMessage {
  return {
    id,
    sessionId: "session-1",
    role: "assistant",
    type: "assistant",
    text,
    timestamp: "2026-09-27T10:00:00.000Z",
    payload: {}
  } as ChatMessage;
}
