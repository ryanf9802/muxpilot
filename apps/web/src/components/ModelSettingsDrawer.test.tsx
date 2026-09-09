// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexModelCatalogResponse, ManagedSession } from "@muxpilot/core";
import { effectiveModelSettings, ModelSettingsDrawer } from "./ModelSettingsDrawer.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    const apply = vi.fn(async () => undefined);
    const close = vi.fn();

    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          title="Session model settings"
          description="Choose settings"
          selections={{
            default: { model: "gpt-default", reasoningEffort: "medium" },
            plan: { model: "gpt-other", reasoningEffort: "high" }
          }}
          activeMode="default"
          fastMode={false}
          catalog={catalog}
          loading={false}
          error=""
          applying={null}
          onClose={close}
          onRetry={() => undefined}
          onApply={apply}
        />
      );
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Codex default");
    expect(container.querySelector('[aria-label="Current Normal model"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Current Plan model"]')).not.toBeNull();
    expect(button(container, "Apply Normal").disabled).toBe(true);
    expect(button(container, "Apply Plan").disabled).toBe(false);

    const otherModel = container.querySelector<HTMLInputElement>('input[name="codex-model"][value="gpt-other"]')!;
    await act(async () => { otherModel.click(); });
    const lowEffort = container.querySelector<HTMLInputElement>('input[name="codex-reasoning-effort"][value="low"]')!;
    await act(async () => { lowEffort.click(); });
    expect(container.querySelector('[aria-label="Current Normal model"]')).not.toBeNull();
    expect(button(container, "Apply Normal").disabled).toBe(false);
    expect(button(container, "Apply Plan").disabled).toBe(false);

    await act(async () => {
      button(container, "Apply Normal").click();
      await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledWith("default", "gpt-other", "low");
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      button(container, "Apply Plan").click();
      await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledWith("plan", "gpt-other", "low");
    act(() => root.unmount());
  });

  it("retains the draft and stays open after applying", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const apply = vi.fn(async () => undefined);
    const close = vi.fn();

    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          title="Session model settings"
          description="Choose settings"
          selections={session().models}
          activeMode="default"
          catalog={catalog}
          loading={false}
          error=""
          applying={null}
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
      button(container, "Apply Normal").click();
      await Promise.resolve();
    });

    expect(apply).toHaveBeenCalledWith("default", "gpt-other", "low");
    expect(close).not.toHaveBeenCalled();
    expect(otherModel.checked).toBe(true);
    act(() => root.unmount());
  });
});

function button(container: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label)!;
}

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
    provider: { kind: "codex", threadId: "thread-1", rolloutPath: null },
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
