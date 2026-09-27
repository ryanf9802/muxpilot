// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession, ProviderModelCatalogResponse } from "@muxpilot/core";
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
          provider="codex"
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
          provider="codex"
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

  it("compacts reviewer apply and session permissions into the model drawer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const applyReviewer = vi.fn(async () => undefined);
    const changeApprovalMode = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          provider="codex"
          title="Settings"
          description="Choose settings"
          selections={session().models}
          activeMode="default"
          catalog={catalog}
          loading={false}
          error=""
          applying={null}
          reviewerSettings={{ model: "gpt-other", reasoningEffort: "low" }}
          approvalMode="ask"
          onClose={() => undefined}
          onRetry={() => undefined}
          onApply={async () => undefined}
          onApplyReviewer={applyReviewer}
          onApprovalModeChange={changeApprovalMode}
        />
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="Current Auto reviewer model"]')).not.toBeNull();
    expect(button(container, "Apply Reviewer").disabled).toBe(false);
    await act(async () => {
      button(container, "Apply Reviewer").click();
      await Promise.resolve();
    });
    expect(applyReviewer).toHaveBeenCalledWith("gpt-default", "medium");

    const permissions = container.querySelector<HTMLSelectElement>('select[aria-label="Session permissions"]')!;
    expect(Array.from(permissions.options).map((option) => option.text)).toEqual([
      "Ask for approval",
      "Auto approval",
      "Full approval"
    ]);
    await act(async () => {
      permissions.value = "auto";
      permissions.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(changeApprovalMode).toHaveBeenCalledWith("auto");
    act(() => root.unmount());
  });

  it("shows an inherited child approval mode without allowing an override", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changeApprovalMode = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          provider="codex"
          title="Settings"
          description="Choose settings"
          selections={session().models}
          activeMode="default"
          catalog={catalog}
          loading={false}
          error=""
          applying={null}
          approvalMode="full"
          approvalModeInheritedFrom={{ id: "parent", name: "Parent work" }}
          onClose={() => undefined}
          onRetry={() => undefined}
          onApply={async () => undefined}
          onApprovalModeChange={changeApprovalMode}
        />
      );
    });

    const permissions = container.querySelector<HTMLSelectElement>('select[aria-label="Session permissions"]')!;
    expect(permissions.value).toBe("full");
    expect(permissions.disabled).toBe(true);
    expect(container.querySelector<HTMLAnchorElement>('a[href="/sessions/parent"]')?.textContent).toBe("Parent work");
    expect(changeApprovalMode).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe("ModelSettingsDrawer for Claude", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("scopes radio names, hides effort for effort-less models and applies a null effort", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const apply = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          provider="claude"
          providerFastMode={false}
          title="Session model settings"
          description="Choose settings"
          selections={{ default: { model: "sonnet", reasoningEffort: "high" }, plan: { model: "sonnet", reasoningEffort: "high" } }}
          activeMode="default"
          fastMode
          catalog={claudeCatalog}
          loading={false}
          error=""
          applying={null}
          reviewerSettings={null}
          onClose={() => undefined}
          onRetry={() => undefined}
          onApply={apply}
          onApplyReviewer={async () => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(container.querySelector('input[name="codex-model"]')).toBeNull();
    expect(container.querySelectorAll('input[name="claude-model"]')).toHaveLength(2);
    expect(container.querySelectorAll('input[name="claude-reasoning-effort"]')).toHaveLength(2);
    expect(container.textContent).not.toContain("Apply Reviewer");

    await act(async () => { container.querySelector<HTMLInputElement>('input[name="claude-model"][value="haiku"]')!.click(); });
    expect(container.querySelector('input[name="claude-reasoning-effort"]')).toBeNull();
    expect(container.textContent).not.toContain("Reasoning effort");
    expect(container.textContent).not.toContain("turn off Fast mode");

    await act(async () => {
      button(container, "Apply Normal").click();
      await Promise.resolve();
    });
    expect(apply).toHaveBeenCalledWith("default", "haiku", null);
    act(() => root.unmount());
  });

  it("warns about Fast mode only for providers that support it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = async (providerFastMode: boolean) => act(async () => {
      root.render(
        <ModelSettingsDrawer
          open
          provider="claude"
          providerFastMode={providerFastMode}
          title="Session model settings"
          description="Choose settings"
          selections={{ default: { model: "sonnet", reasoningEffort: "high" }, plan: { model: "sonnet", reasoningEffort: "high" } }}
          activeMode="default"
          fastMode
          catalog={claudeCatalog}
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

    await render(true);
    await act(async () => { container.querySelector<HTMLInputElement>('input[name="claude-model"][value="haiku"]')!.click(); });
    expect(container.textContent).toContain("will turn off Fast mode");
    act(() => root.unmount());
  });
});

const claudeCatalog: ProviderModelCatalogResponse = {
  provider: "claude",
  models: [
    {
      id: "sonnet",
      model: "sonnet",
      displayName: "Sonnet",
      description: "Balanced",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deeper" }
      ],
      defaultReasoningEffort: "medium",
      supportsFastMode: true
    },
    {
      id: "haiku",
      model: "haiku",
      displayName: "Haiku",
      description: "Fast",
      hidden: false,
      isDefault: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      supportsFastMode: false
    }
  ],
  defaults: {
    default: { model: "sonnet", reasoningEffort: "medium" },
    plan: { model: "sonnet", reasoningEffort: "high" }
  }
};

function button(container: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label)!;
}

const catalog: ProviderModelCatalogResponse = {
  provider: "codex",
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
      supportsFastMode: true
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
      supportsFastMode: false
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
    provider: { kind: "codex", threadId: "thread-1", transcriptPath: null },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    discoveryConfidence: "high",
    status: "waiting",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    approvalMode: "ask",
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
