// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProviderKind, ProviderDescriptor } from "@muxpilot/core";
import { providerDescriptor } from "../testing/providerFixtures.js";
import { ProviderSelector, providerOptionStatus } from "./ProviderSelector.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("ProviderSelector", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn<(provider: AgentProviderKind) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onChange = vi.fn<(provider: AgentProviderKind) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("exposes a labelled radiogroup with a roving tab stop on the checked option", async () => {
    await render([providerDescriptor("codex"), providerDescriptor("claude")], "claude");

    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-labelledby")).toBe(container.querySelector(".provider-selector-label")?.id);
    const options = radios();
    expect(options.map((option) => option.textContent)).toEqual(["CodexReady · 1.0.0", "ClaudeReady · 1.0.0"]);
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0]);
  });

  it("moves selection with arrow keys and skips providers that cannot start sessions", async () => {
    const providers = [
      providerDescriptor("codex"),
      providerDescriptor("claude", { authStatus: "signed_out" })
    ];
    await render(providers, "codex");

    await act(async () => {
      radios()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toContain("Codex");
    expect(radios()[1]!.getAttribute("aria-disabled")).toBe("true");

    await act(async () => { radios()[1]!.click(); });
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toContain("Codex");
  });

  it("wraps arrow navigation across selectable providers", async () => {
    await render([providerDescriptor("codex"), providerDescriptor("claude")], "codex");

    await act(async () => {
      radios()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(container.querySelector('[aria-checked="true"]')?.textContent).toContain("Claude");
    expect(document.activeElement).toBe(radios()[1]);
    expect(onChange).toHaveBeenLastCalledWith("claude");
  });

  it("explains a blocked selection with the host login command", async () => {
    const checkAuth = vi.fn(async () => null);
    await render([providerDescriptor("codex"), providerDescriptor("claude", { authStatus: "authentication_required" })], "claude", checkAuth);

    const note = container.querySelector(".provider-selector-note")!;
    expect(note.getAttribute("role")).toBe("note");
    expect(note.textContent).toContain("Claude needs to sign in again.");
    expect(note.querySelector("code")?.textContent).toBe("claude auth login");
    const check = Array.from(note.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Check again")!;
    await act(async () => { check.click(); });
    expect(checkAuth).toHaveBeenCalledWith("claude");
  });

  it("summarizes each provider's readiness", () => {
    expect(providerOptionStatus(providerDescriptor("claude", { compatibility: { status: "missing_binary", available: false } }))).toBe("Not installed");
    expect(providerOptionStatus(providerDescriptor("claude", { authStatus: "checking" }))).toBe("Checking sign-in");
    expect(providerOptionStatus(providerDescriptor("codex", { compatibility: { version: null } }))).toBe("Ready");
  });

  it("renders a single provider as a status line instead of a one-option group", async () => {
    await render([providerDescriptor("codex", { compatibility: { version: "0.152.0" } })], "codex");
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container.textContent).toContain("Codex 0.152.0 is available.");
  });

  function radios(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  }

  async function render(providers: ProviderDescriptor[], initial: AgentProviderKind, onCheckAuth?: (provider: AgentProviderKind) => Promise<unknown>) {
    function Harness() {
      const [value, setValue] = useState(initial);
      return (
        <ProviderSelector
          providers={providers}
          value={value}
          onChange={(provider) => {
            onChange(provider);
            setValue(provider);
          }}
          onCheckAuth={onCheckAuth}
        />
      );
    }
    await act(async () => { root.render(<Harness />); });
  }
});
