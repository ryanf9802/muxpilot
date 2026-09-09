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
    expect(container.querySelector('[aria-label="Current Normal combination"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Current Plan combination"]')).not.toBeNull();
    expect(button(container, "Apply Normal").disabled).toBe(true);
    expect(button(container, "Apply Plan").disabled).toBe(false);

    const lowEffort = container.querySelector<HTMLInputElement>('input[name="codex-model-combination"][value="gpt-other:low"]')!;
    await act(async () => { lowEffort.click(); });
    expect(container.querySelector('[aria-label="Current Normal combination"]')).not.toBeNull();
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

    const otherModel = container.querySelector<HTMLInputElement>('input[name="codex-model-combination"][value="gpt-other:low"]')!;
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

  it("shows independent quality and usage estimates and preserves unknown combinations", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const comparisonCatalog: CodexModelCatalogResponse = {
      ...catalog,
      models: [
        { ...catalog.models[0]!, id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
        { ...catalog.models[1]!, id: "future-model", model: "future-model", displayName: "Future Model" }
      ],
      defaults: {
        default: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
        plan: { model: "gpt-5.6-terra", reasoningEffort: "high" }
      }
    };

    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          title="Session model settings"
          description="Choose settings"
          selections={{ default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } }}
          activeMode="default"
          fastMode
          catalog={comparisonCatalog}
          loading={false}
          error=""
          applying={null}
          onClose={() => undefined}
          onRetry={() => undefined}
          onApply={async () => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="Estimated quality: Very high, 4 of 5"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Estimated usage: Low, 2 of 5"]')).not.toBeNull();
    expect(container.textContent).toContain("Quality and usage: Not yet rated");
    const details = container.querySelector("details")!;
    details.open = true;
    expect(details.textContent).toContain("25–200 local messages per 5 hours on Plus");
    expect(details.textContent).toContain("Fast mode is on");
    expect(details.querySelector('a[href="https://learn.chatgpt.com/docs/pricing"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("keeps models without reasoning controls selectable", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const noEffortCatalog: CodexModelCatalogResponse = {
      models: [{ ...catalog.models[0]!, supportedReasoningEfforts: [], defaultReasoningEffort: null }],
      defaults: { default: { model: "gpt-default", reasoningEffort: null }, plan: { model: "gpt-default", reasoningEffort: null } }
    };
    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open title="Session model settings" description="Choose settings"
          selections={{ default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } }}
          activeMode="default" catalog={noEffortCatalog} loading={false} error="" applying={null}
          onClose={() => undefined} onRetry={() => undefined} onApply={async () => undefined}
        />
      );
      await Promise.resolve();
    });
    const standard = container.querySelector<HTMLInputElement>('input[value="gpt-default:none"]');
    expect(standard?.checked).toBe(true);
    expect(container.textContent).toContain("Standard");
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
