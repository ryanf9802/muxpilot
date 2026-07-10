import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_EXPIRED_EVENT, ApiError, api, isUnauthorizedError } from "./client.js";

describe("api client request headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not send a JSON content type for bodyless logout requests", async () => {
    const fetchMock = mockJsonResponse({ ok: true });

    await api.logout();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/logout",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("sends access keys to the operator access endpoint", async () => {
    const fetchMock = mockJsonResponse({ ok: true });

    await api.access("secret-access-key");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/access",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(init.body).toBe(JSON.stringify({ accessKey: "secret-access-key" }));
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("dispatches an auth-expired event when the API returns 401", async () => {
    const authEvents = new EventTarget();
    const listener = vi.fn();
    authEvents.addEventListener(AUTH_EXPIRED_EVENT, listener);
    vi.stubGlobal("window", authEvents);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Operator access required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      })
    );

    await expect(api.sessions()).rejects.toThrow("Operator access required");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch auth-expired for network failures", async () => {
    const authEvents = new EventTarget();
    const listener = vi.fn();
    authEvents.addEventListener(AUTH_EXPIRED_EVENT, listener);
    vi.stubGlobal("window", authEvents);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(api.sessions()).rejects.toThrow("Failed to fetch");

    expect(listener).not.toHaveBeenCalled();
  });

  it("exposes unauthorized API errors without classifying network failures as unauthorized", async () => {
    expect(isUnauthorizedError(new ApiError("Operator access required", 401))).toBe(true);
    expect(isUnauthorizedError(new ApiError("Server error", 500))).toBe(false);
    expect(isUnauthorizedError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("loads LAN connectivity from the same-origin API", async () => {
    const fetchMock = mockJsonResponse({ urls: [] });

    await api.connectivity();

    expect(fetchMock).toHaveBeenCalledWith("/api/connectivity", expect.objectContaining({ credentials: "include" }));
  });

  it("loads host-only remote access details", async () => {
    const fetchMock = mockJsonResponse({ urls: [], accessUrls: [], accessKey: "river-slate-42-orbit-copper-17" });

    await api.remoteAccess();

    expect(fetchMock).toHaveBeenCalledWith("/api/remote-access", expect.objectContaining({ credentials: "include" }));
  });

  it("revokes remote access with a bodyless post", async () => {
    const fetchMock = mockJsonResponse({ urls: [], accessUrls: [], accessKey: "river-slate-42-orbit-copper-18" });

    await api.revokeRemoteAccess();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/remote-access/revoke",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(init.body).toBeUndefined();
  });

  it("updates remote access settings", async () => {
    const fetchMock = mockJsonResponse({ urls: [], accessUrls: [], accessKey: "river-slate-42-orbit-copper-17" });

    await api.updateRemoteAccessSettings({ unrestrictedRemoteAccess: true });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/remote-access/settings",
      expect.objectContaining({ method: "PATCH", credentials: "include" })
    );
    expect(init.body).toBe(JSON.stringify({ unrestrictedRemoteAccess: true }));
  });

  it("requests message pages with cursor query parameters", async () => {
    const fetchMock = mockJsonResponse({ messages: [], hasMoreBefore: false, hasMoreAfter: false });

    await api.messages("session-1", { before: 120, limit: 80 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/messages?before=120&limit=80",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("requests the oldest message page for top jumps", async () => {
    const fetchMock = mockJsonResponse({ messages: [], hasMoreBefore: false, hasMoreAfter: true });

    await api.messages("session-1", { position: "oldest", limit: 80 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/messages?limit=80&position=oldest",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("requests prompt history with an encoded query and limit", async () => {
    const fetchMock = mockJsonResponse({ results: [] });

    await api.promptHistory("graph view", 50);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/prompt-history?q=graph%20view&limit=50",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("sends chat input with the selected collaboration mode", async () => {
    const fetchMock = mockJsonResponse({ ok: true });

    await api.send("session-1", "Plan this", "plan");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/input",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(init.body).toBe(JSON.stringify({ text: "Plan this", mode: "plan" }));
  });

  it("sends session actions with explicit input mode targets", async () => {
    const fetchMock = mockJsonResponse({ ok: true, session: { id: "session-1", inputMode: "plan" } });

    const response = await api.action("session-1", { type: "setInputMode", mode: "plan" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/actions",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(init.body).toBe(JSON.stringify({ type: "setInputMode", mode: "plan" }));
    expect(response.session?.inputMode).toBe("plan");
  });

  it("fetches discovered Codex skills", async () => {
    const fetchMock = mockJsonResponse({ skills: [] });

    await api.codexSkills();

    expect(fetchMock).toHaveBeenCalledWith("/api/codex/skills", expect.objectContaining({ credentials: "include" }));
  });

  it("checks and installs the muxpilot Git workflow skill", async () => {
    const fetchMock = mockJsonResponse({ status: "current", path: "/home/user/.codex/skills/muxpilot-git-workflow" });

    await api.gitWorkflowSkillStatus();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/codex/skills/muxpilot-git-workflow/status",
      expect.objectContaining({ credentials: "include" })
    );

    await api.installGitWorkflowSkill();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/codex/skills/muxpilot-git-workflow/install",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
  });

  it("fetches session-scoped Codex skills", async () => {
    const fetchMock = mockJsonResponse({ skills: [] });

    await api.codexSkills("session-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/skills", expect.objectContaining({ credentials: "include" }));
  });

  it("fetches session directory suggestions", async () => {
    const fetchMock = mockJsonResponse({ directories: [] });

    await api.sessionDirectories();

    expect(fetchMock).toHaveBeenCalledWith("/api/session-directories", expect.objectContaining({ credentials: "include" }));
  });

  it("checks target branch existence after target input is committed", async () => {
    const fetchMock = mockJsonResponse({ exists: false });

    await api.gitTargetBranchStatus("/repo", "Feature/API_v2");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/git/target-branch-status?cwd=%2Frepo&branch=Feature%2FAPI_v2",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("creates sessions from a cwd and name", async () => {
    const fetchMock = mockJsonResponse({ session: { id: "created-session" } });

    await api.createSession({ cwd: "/repo", name: "new-work" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(init.body).toBe(JSON.stringify({ cwd: "/repo", name: "new-work" }));
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("searches and restores session history", async () => {
    const fetchMock = mockJsonResponse({ results: [] });

    await api.sessionHistory("build graph", 25);
    await api.restoreSession("session-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/session-history?q=build%20graph&limit=25");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/session-history/session-1/restore");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("POST");
  });

  it("manages queued inputs for a session", async () => {
    const fetchMock = mockJsonResponse({ queuedInputs: [] });

    await api.queuedInputs("session-1");
    await api.enqueueInput("session-1", "first queued", "plan");
    await api.updateQueuedInput("session-1", "queued-1", "edited queued", "default");
    await api.deleteQueuedInput("session-1", "queued-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/session-1/queued-inputs");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/sessions/session-1/queued-inputs");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBe(JSON.stringify({ text: "first queued", mode: "plan" }));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/sessions/session-1/queued-inputs/queued-1");
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe("PATCH");
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).body).toBe(JSON.stringify({ text: "edited queued", mode: "default" }));
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/sessions/session-1/queued-inputs/queued-1");
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("DELETE");
  });
});

function mockJsonResponse(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }))
  );
}
