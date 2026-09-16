// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useOutletContext } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DashboardSessionSummary, ManagedSession } from "@muxpilot/core";
import * as client from "../api/client.js";
import { AppShell, type AppShellOutletContext } from "./AppShell.js";

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
  it("opens profile management from an account button before app logout", async () => {
    mockShellApi(fakeSocket(), async () => ({ sessions: [] }));
    vi.spyOn(client.api, "codexAuth").mockResolvedValue({
      status: "ready",
      account: { type: "chatgpt", email: "operator@example.com", planType: "pro" },
      activeProfileId: null,
      profiles: [],
      revision: 1,
      observedAt: "2026-09-16T03:00:00.000Z",
      error: null,
      admissionHeld: false,
      pendingSessionIds: [],
      credentialStorage: "file"
    });

    await renderShell(() => undefined);
    const accountButton = container?.querySelector<HTMLButtonElement>('[aria-label="Manage Codex accounts"]');
    const logoutButton = container?.querySelector<HTMLButtonElement>('[aria-label="Clear access"]');
    expect(accountButton).not.toBeNull();
    expect(logoutButton).not.toBeNull();
    expect(accountButton!.compareDocumentPosition(logoutButton!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => {
      accountButton?.click();
      await flushPromises();
    });
    expect(container?.querySelector('[role="dialog"]')?.textContent).toContain("Codex accounts");
    expect(container?.querySelector('[role="dialog"]')?.textContent).toContain("operator@example.com");
    expect(container?.querySelector('[role="dialog"]')?.textContent).not.toContain("Sign out");
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

function mockShellApi(socket: ReturnType<typeof fakeSocket>, summaries: () => Promise<{ sessions: DashboardSessionSummary[] }>): void {
  vi.spyOn(client.api, "me").mockResolvedValue({
    accessGranted: true,
    accessKeyRequired: false,
    accessMode: "local",
    sessionHostMode: "local"
  });
  vi.spyOn(client.api, "sessionSummaries").mockImplementation(summaries);
  vi.spyOn(client.api, "notificationSettings").mockResolvedValue({} as never);
  vi.spyOn(client.api, "sessionRecovery").mockResolvedValue({ incident: null });
  vi.spyOn(client.api, "appServerCompatibility").mockResolvedValue({
    status: "available",
    available: true,
    codexVersion: "test",
    detail: "ready",
    checkedAt: "2026-09-10T12:00:00.000Z",
    missingCapabilities: []
  });
  vi.spyOn(client, "eventSocket").mockReturnValue(socket as unknown as WebSocket);
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
    provider: { kind: "codex", threadId: null, rolloutPath: null },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: null,
    codexJsonlPath: null,
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
