// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexModelCatalogResponse, ManagedSession } from "@muxpilot/core";
import { effectiveModelSettings, ModelSettingsDrawer } from "./ModelSettingsDrawer.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("ModelSettingsDrawer", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("resolves unset session modes through the Codex presets", () => {
    expect(effectiveModelSettings(session(), catalog.defaults, "plan")).toEqual({
      model: "gpt-default",
      reasoningEffort: "high"
    });
  });

  it("keeps current badges visible while applying a draft model and effort together", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const apply = vi.fn(async () => true);
    const close = vi.fn();

    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          session={session({
            models: {
              default: { model: "gpt-default", reasoningEffort: "medium" },
              plan: { model: "gpt-other", reasoningEffort: "high" }
            }
          })}
          catalog={catalog}
          loading={false}
          error=""
          applying={false}
          onClose={close}
          onRetry={() => undefined}
          onApply={apply}
        />
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="Codex default model"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Current Normal model"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Current Plan model"]')).not.toBeNull();

    const otherModel = container.querySelector<HTMLInputElement>('input[name="codex-model"][value="gpt-other"]')!;
    await act(async () => { otherModel.click(); });
    const lowEffort = container.querySelector<HTMLInputElement>('input[name="codex-reasoning-effort"][value="low"]')!;
    await act(async () => { lowEffort.click(); });
    expect(container.querySelector('[aria-label="Current Normal model"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
      await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledWith("default", "gpt-other", "low");
    expect(close).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("retains the draft and stays open when Apply fails", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const apply = vi.fn(async () => false);
    const close = vi.fn();

    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          session={session()}
          catalog={catalog}
          loading={false}
          error=""
          applying={false}
          onClose={close}
          onRetry={() => undefined}
          onApply={apply}
        />
      );
      await Promise.resolve();
    });

    const otherModel = container.querySelector<HTMLInputElement>('input[name="codex-model"][value="gpt-other"]')!;
    await act(async () => { otherModel.click(); });
    await act(async () => {
      container.querySelector<HTMLFormElement>("form")!.requestSubmit();
      await Promise.resolve();
    });

    expect(apply).toHaveBeenCalledWith("default", "gpt-other", "low");
    expect(close).not.toHaveBeenCalled();
    expect(otherModel.checked).toBe(true);
    act(() => root.unmount());
  });
});

const catalog: CodexModelCatalogResponse = {
  models: [
    {
      id: "gpt-default",
      model: "gpt-default",
      displayName: "GPT Default",
      description: "Default model",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deeper" }
      ],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", name: "Fast", description: "Priority" }]
    },
    {
      id: "gpt-other",
      model: "gpt-other",
      displayName: "GPT Other",
      description: "Alternative model",
      hidden: false,
      isDefault: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Quick" },
        { reasoningEffort: "high", description: "Deep" }
      ],
      defaultReasoningEffort: "low",
      serviceTiers: []
    }
  ],
  defaults: {
    default: { model: "gpt-default", reasoningEffort: "medium" },
    plan: { model: "gpt-default", reasoningEffort: "high" }
  }
};

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "session-1",
    name: "session-1",
    cwd: "/repo",
    driverKind: "codex_app_server",
    tmux: {
      sessionId: "muxpilot",
      sessionName: "muxpilot",
      windowId: "@1",
      windowIndex: 1,
      windowName: "session-1",
      paneId: "%1",
      paneIndex: 0,
      paneActive: false,
      cwd: "/repo",
      currentCommand: "codex",
      title: "session-1",
      pid: 1,
      size: "120x40"
    },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: null,
    discoveryConfidence: "high",
    status: "waiting",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: {
      default: { model: null, reasoningEffort: null },
      plan: { model: null, reasoningEffort: null }
    },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false,
    ...overrides
  };
}
