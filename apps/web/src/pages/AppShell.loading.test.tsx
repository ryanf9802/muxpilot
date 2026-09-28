// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useOutletContext } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DashboardSessionSummary, ManagedSession, ProviderAuthState, ProviderDescriptor } from "@muxpilot/core";
import * as client from "../api/client.js";
import { AppShell, type AppShellOutletContext } from "./AppShell.js";
import { providerDescriptor } from "../testing/providerFixtures.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("AppShell session loading", () => {
  it("does not expose Codex account management", async () => {
    mockShellApi(fakeSocket(), async () => ({ sessions: [] }));

    await renderShell(() => undefined);

    expect(container?.querySelector('[aria-label="Manage Codex accounts"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Manage Claude accounts"]')).toBeNull();
    const labels = Array.from(container?.querySelectorAll("button, a") ?? [], (element) => `${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""}`);
    expect(labels.some((label) => /sign in|log in|login/i.test(label))).toBe(false);
    expect(container?.querySelector('[aria-label="Clear access"]')).not.toBeNull();
  });

  it("applies provider authentication events without touching the session list", async () => {
    const socket = fakeSocket();
    const summaries = vi.fn(async () => ({ sessions: [testSession("existing", "waiting")] }));
    mockShellApi(socket, summaries, [providerDescriptor("codex"), providerDescriptor("claude", { authStatus: "signed_out", auth: { revision: 2 } })]);
    const observed: { current: AppShellOutletContext | null } = { current: null };
    await renderShell((value) => { observed.current = value; });
    await act(async () => { await flushPromises(); });
    const sessionsBefore = observed.current?.sessions;
    const loadsBefore = summaries.mock.calls.length;

    await act(async () => {
      socket.onmessage?.(messageEvent({
        id: "auth-stale",
        type: "provider.auth.updated",
        sessionId: "__app__",
        timestamp: "2026-09-18T12:00:00.000Z",
        payload: authPayload("claude", "ready", 1)
      }));
      await flushPromises();
    });
    expect(observed.current?.providers.providers.find((descriptor) => descriptor.kind === "claude")?.auth.status).toBe("signed_out");
    expect(summaries.mock.calls.length).toBe(loadsBefore);

    await act(async () => {
      socket.onmessage?.(messageEvent({
        id: "auth-ready",
        type: "provider.auth.updated",
        sessionId: "__app__",
        timestamp: "2026-09-18T12:00:01.000Z",
        payload: authPayload("claude", "ready", 3)
      }));
      await flushPromises();
    });
    expect(observed.current?.providers.providers.find((descriptor) => descriptor.kind === "claude")?.auth).toMatchObject({ status: "ready", revision: 3 });
    expect(observed.current?.sessions.map((session) => session.id)).toEqual(sessionsBefore?.map((session) => session.id));
    expect(observed.current?.sessions.some((session) => session.id === "__app__")).toBe(false);
    expect(summaries.mock.calls.length).toBe(loadsBefore + 1);
  });

  it("preselects the session provider for Ctrl+N and creates the session with the chosen provider", async () => {
    installLocalStorage();
    mockShellApi(fakeSocket(), async () => ({ sessions: [] }));
    vi.spyOn(client.api, "sessionDirectories").mockResolvedValue({ directories: [] });
    vi.spyOn(client.api, "gitRepositoryProbe").mockResolvedValue({
      isGit: false, bare: false, incompatibleReason: null, repoRoot: null, repoName: "repo", currentBranch: null, dirty: false, localBranches: [], remotes: []
    });
    const createSession = vi.spyOn(client.api, "createSession").mockResolvedValue({ session: testSession("created", "waiting") as ManagedSession });
    const observed: { current: AppShellOutletContext | null } = { current: null };
    await renderShell((value) => { observed.current = value; });
    await act(async () => { await flushPromises(); });

    act(() => { observed.current!.registerCreateSessionPrefill(() => ({ cwd: "/repo", provider: "claude" })); });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true }));
      await flushPromises();
    });
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Claude");

    await act(async () => { (document.querySelector('[role="radio"][data-provider="codex"]') as HTMLButtonElement).click(); });
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Codex");
    await act(async () => { (document.querySelector('[role="radio"][data-provider="claude"]') as HTMLButtonElement).click(); });

    const nameInput = Array.from(document.querySelectorAll<HTMLLabelElement>(".rename-field"))
      .find((label) => label.querySelector("span")?.textContent === "Name")!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "claude-work");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Create" && button.getAttribute("type") === "submit") as HTMLButtonElement).click();
      await flushPromises();
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", name: "claude-work", provider: "claude" }));
    expect(window.localStorage.getItem("muxpilot.new-session.provider.v1")).toBe("claude");
  });

  it("offers remaining-capacity notification thresholds beneath status changes", async () => {
    mockShellApi(fakeSocket(), async () => ({ sessions: [] }));
    await renderShell(() => undefined);

    await act(async () => {
      (container?.querySelector('[aria-label="Global notifications"]') as HTMLButtonElement).click();
    });
    const menuLabels = Array.from(container?.querySelectorAll('[aria-label="Global notification settings"] button') ?? [], (button) => button.textContent?.trim());
    expect(menuLabels.indexOf("Usage limits")).toBe(menuLabels.indexOf("Status change") + 1);

    await act(async () => buttonWithText("Usage limits").click());
    expect(Array.from(container?.querySelectorAll('[aria-label="Usage limit notification settings"] button') ?? [], (button) => button.textContent?.trim()))
      .toEqual(["75% left", "50% left", "25% left", "10% left", "0% left"]);

    await act(async () => buttonWithText("25% left").click());
    expect(client.api.updateNotificationSetting).toHaveBeenCalledWith(expect.objectContaining({ setting: "usage_limit", threshold: 25, enabled: false }));
  });

  it("renders server usage-limit events through the global toast channel", async () => {
    const socket = fakeSocket();
    mockShellApi(socket, async () => ({ sessions: [] }));
    await renderShell(() => undefined);

    await act(async () => {
      socket.onmessage?.(messageEvent({
        id: "usage-warning",
        type: "usage.notification.triggered",
        sessionId: "codex-usage",
        timestamp: "2026-09-18T12:00:00.000Z",
        payload: {
          deviceId: "device-test",
          provider: "codex",
          limit: "five_hour",
          limitLabel: "5h limit",
          remainingPercent: 24,
          threshold: 25,
          severity: "yellow",
          title: "Codex usage limit warning",
          body: "5h limit has 24% remaining.",
          url: "/"
        }
      }));
      await flushPromises();
    });

    expect(container?.textContent).toContain("Codex: 5h limit has 24% remaining.");
  });

  it("finishes initial loading without overwriting a live session update", async () => {
    const snapshot = deferred<{ sessions: DashboardSessionSummary[] }>();
    const socket = fakeSocket();
    mockShellApi(socket, () => snapshot.promise);
    const observed: { current: AppShellOutletContext | null } = { current: null };

    await renderShell((value) => { observed.current = value; });
    const live = testSession("live", "waiting");
    await act(async () => {
      socket.onmessage?.(messageEvent({
        id: "live-update",
        type: "session.updated",
        sessionId: live.id,
        payload: live,
        timestamp: "2026-09-10T12:00:00.000Z"
      }));
      snapshot.resolve({ sessions: [testSession("stale", "working")] });
      await snapshot.promise;
      await flushPromises();
    });

    expect(observed.current?.sessionsLoaded).toBe(true);
    expect(observed.current?.sessions.map((session) => session.id)).toEqual(["stale", "live"]);
    expect(observed.current?.sessions.find((session) => session.id === "live")?.status).toBe("waiting");
  });

  it("replaces initial loading with a retryable error and recovers", async () => {
    const second = deferred<{ sessions: DashboardSessionSummary[] }>();
    const summaries = vi.fn()
      .mockRejectedValueOnce(new Error("network stalled"))
      .mockImplementationOnce(() => second.promise);
    mockShellApi(fakeSocket(), summaries);
    const observed: { current: AppShellOutletContext | null } = { current: null };

    await renderShell((value) => { observed.current = value; });
    await act(async () => { await flushPromises(); });
    expect(observed.current?.sessionsLoaded).toBe(false);
    expect(observed.current?.sessionsLoadError).toContain("could not load sessions");

    const recovered = testSession("recovered", "waiting");
    await act(async () => {
      const retry = observed.current?.retrySessions();
      second.resolve({ sessions: [recovered] });
      await retry;
    });
    expect(observed.current?.sessionsLoaded).toBe(true);
    expect(observed.current?.sessionsLoadError).toBeNull();
    expect(observed.current?.sessions).toEqual([recovered]);
    expect(summaries).toHaveBeenCalledTimes(2);
  });
});

async function renderShell(onContext: (context: AppShellOutletContext) => void): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<ContextProbe onContext={onContext} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    await flushPromises();
  });
}

function ContextProbe({ onContext }: { onContext: (context: AppShellOutletContext) => void }) {
  const context = useOutletContext<AppShellOutletContext>();
  useEffect(() => onContext(context), [context, onContext]);
  return null;
}

function mockShellApi(
  socket: ReturnType<typeof fakeSocket>,
  summaries: () => Promise<{ sessions: DashboardSessionSummary[] }>,
  providers: ProviderDescriptor[] = [providerDescriptor("codex"), providerDescriptor("claude")]
): void {
  vi.spyOn(client.api, "me").mockResolvedValue({
    accessGranted: true,
    accessKeyRequired: false,
    accessMode: "local",
    sessionHostMode: "local"
  });
  vi.spyOn(client.api, "sessionSummaries").mockImplementation(summaries);
  const notificationSettings = {
    globalRules: ["status_change" as const],
    sessionRules: {},
    usageLimitThresholds: [75, 50, 25, 10, 0] as const,
    delivery: { pushEnabled: false, soundEnabled: true }
  };
  vi.spyOn(client.api, "notificationSettings").mockResolvedValue(notificationSettings as never);
  vi.spyOn(client.api, "updateNotificationSetting").mockResolvedValue(notificationSettings as never);
  vi.spyOn(client.api, "providerUsageSummary").mockImplementation(async (provider) => ({
    provider,
    available: true,
    error: null,
    refreshedAt: "2026-09-10T12:00:00.000Z",
    accountStatus: "authenticated",
    account: null,
    limits: [],
    resetCredits: null
  }));
  vi.spyOn(client.api, "sessionRecovery").mockResolvedValue({ incident: null });
  vi.spyOn(client.api, "providers").mockResolvedValue({
    defaultProvider: "codex",
    providers
  });
  vi.spyOn(client, "eventSocket").mockReturnValue(socket as unknown as WebSocket);
}

function buttonWithText(label: string): HTMLButtonElement {
  const button = Array.from(container?.querySelectorAll("button") ?? []).find((candidate) => candidate.textContent?.trim() === label);
  expect(button, `button ${label}`).toBeDefined();
  return button as HTMLButtonElement;
}

function installLocalStorage(): void {
  const stored = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear()
    }
  });
}

function authPayload(provider: ProviderAuthState["provider"], status: ProviderAuthState["status"], revision: number): ProviderAuthState {
  return { provider, status, account: null, revision, observedAt: "2026-09-18T12:00:00.000Z", error: null, admissionHeld: false, pendingSessionIds: [] };
}

function fakeSocket() {
  return {
    onmessage: null as ((event: MessageEvent<string>) => unknown) | null,
    onclose: null as (() => unknown) | null,
    close: vi.fn()
  };
}

function messageEvent(data: unknown): MessageEvent<string> {
  return new MessageEvent("message", { data: JSON.stringify(data) });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function testSession(id: string, status: ManagedSession["status"]): DashboardSessionSummary {
  return {
    id,
    name: id,
    cwd: "/repo",
    provider: { kind: "codex", threadId: null, transcriptPath: null },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    discoveryConfidence: "medium",
    lastActivityAt: "2026-09-10T12:00:00.000Z",
    status,
    preview: "",
    recentUserPrompts: [],
    approvalMode: "ask",
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false,
    agentOwnership: null
  };
}
