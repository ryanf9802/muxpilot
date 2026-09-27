// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuthState } from "@muxpilot/core";
import { providerDescriptor } from "../testing/providerFixtures.js";

const apiMocks = vi.hoisted(() => ({
  providers: vi.fn(),
  refreshProviderAuth: vi.fn(),
  setDefaultProvider: vi.fn()
}));

vi.mock("../api/client.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../api/client.js")>(), api: apiMocks }));

import { isProviderAuthUpdatedEvent, useProviders, type ProvidersState } from "./useProviders.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("useProviders", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ProvidersState | null;

  beforeEach(() => {
    current = null;
    apiMocks.providers.mockReset().mockResolvedValue({
      defaultProvider: "codex",
      providers: [providerDescriptor("codex", { auth: { revision: 4 } }), providerDescriptor("claude", { authStatus: "signed_out", auth: { revision: 2 } })]
    });
    apiMocks.refreshProviderAuth.mockReset();
    apiMocks.setDefaultProvider.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads the catalog only while connected and reloads on a new connection epoch", async () => {
    await render(false, 0);
    expect(apiMocks.providers).not.toHaveBeenCalled();
    expect(current?.loaded).toBe(false);

    await render(true, 0);
    expect(apiMocks.providers).toHaveBeenCalledTimes(1);
    expect(current?.loaded).toBe(true);
    expect(current?.providers.map((descriptor) => descriptor.kind)).toEqual(["codex", "claude"]);

    await render(true, 1);
    expect(apiMocks.providers).toHaveBeenCalledTimes(2);
  });

  it("applies newer authentication revisions and ignores stale ones", async () => {
    await render(true, 0);

    let result = apply(authState("claude", "ready", 1));
    expect(result).toEqual({ applied: false, becameReady: false });
    expect(current?.providers.find((descriptor) => descriptor.kind === "claude")?.auth.status).toBe("signed_out");

    result = apply(authState("claude", "ready", 3));
    expect(result).toEqual({ applied: true, becameReady: true });
    expect(current?.providers.find((descriptor) => descriptor.kind === "claude")?.auth).toMatchObject({ status: "ready", revision: 3 });

    result = apply(authState("claude", "signed_out", 2));
    expect(result.applied).toBe(false);
    expect(current?.providers.find((descriptor) => descriptor.kind === "claude")?.auth.status).toBe("ready");
    expect(current?.providers.find((descriptor) => descriptor.kind === "codex")?.auth.revision).toBe(4);
  });

  it("refreshes one provider's authentication through the API", async () => {
    apiMocks.refreshProviderAuth.mockResolvedValue(authState("claude", "ready", 5));
    await render(true, 0);

    await act(async () => { await current!.refreshAuth("claude"); });

    expect(apiMocks.refreshProviderAuth).toHaveBeenCalledWith("claude");
    expect(current?.providers.find((descriptor) => descriptor.kind === "claude")?.auth.status).toBe("ready");
  });

  it("recognizes provider authentication events", () => {
    expect(isProviderAuthUpdatedEvent({ type: "provider.auth.updated", payload: authState("codex", "ready", 1) })).toBe(true);
    expect(isProviderAuthUpdatedEvent({ type: "provider.auth.updated", payload: {} })).toBe(false);
    expect(isProviderAuthUpdatedEvent({ type: "session.updated", payload: authState("codex", "ready", 1) })).toBe(false);
  });

  function apply(state: ProviderAuthState) {
    let result: ReturnType<ProvidersState["applyAuthUpdate"]> | null = null;
    act(() => { result = current!.applyAuthUpdate(state); });
    return result!;
  }

  async function render(connected: boolean, connectionEpoch: number) {
    await act(async () => {
      root.render(<Probe connected={connected} connectionEpoch={connectionEpoch} onState={(state) => { current = state; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function Probe({ connected, connectionEpoch, onState }: { connected: boolean; connectionEpoch: number; onState: (state: ProvidersState) => void }) {
  const state = useProviders({ connected, connectionEpoch });
  useEffect(() => onState(state), [onState, state]);
  return null;
}

function authState(provider: ProviderAuthState["provider"], status: ProviderAuthState["status"], revision: number): ProviderAuthState {
  return {
    provider,
    status,
    account: null,
    revision,
    observedAt: "2026-09-01T12:00:00.000Z",
    error: null,
    admissionHeld: false,
    pendingSessionIds: []
  };
}
