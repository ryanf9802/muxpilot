import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagedSession, RemoteAccessResponse, SessionDirectorySuggestion } from "@muxpilot/core";
import {
  activeSessionStoplightSeverity,
  AppBrand,
  AppRecoveryPage,
  ConnectDeviceContent,
  DisconnectedNotice,
  SHELL_RECONNECT_INTERVAL_MS,
  SessionStoplight,
  filterSessionDirectorySuggestions,
  mergeSessionDirectorySuggestions,
  nextSessionStoplightSearch,
  remoteAccessQrValue,
  sessionDirectorySuggestionsFromSessions,
  sessionNameValidationMessage,
  shouldShowConnectDeviceButton,
  shouldShowLogoutButton,
  syncSessionIntoStoplightSessions
} from "./AppShell.js";
import { directorySuggestionLabel } from "../utils/sessionDirectories.js";

describe("shell connection state", () => {
  it("renders the app logo next to the wordmark", () => {
    const html = renderToStaticMarkup(createElement(AppBrand));

    expect(html).toContain('class="brand-logo"');
    expect(html).toContain('src="/favicon.svg"');
    expect(html).toContain("<strong>muxpilot</strong>");
  });

  it("uses a short reconnect interval for transient disconnects", () => {
    expect(SHELL_RECONNECT_INTERVAL_MS).toBe(2000);
  });

  it("renders a clear disconnected reconnecting notice", () => {
    const html = renderToStaticMarkup(createElement(DisconnectedNotice));

    expect(html).toContain('role="status"');
    expect(html).toContain("Disconnected from muxpilot. Reconnecting...");
    expect(html).toContain("spin");
  });

  it("renders a full recovery page for app and backend failures", () => {
    const html = renderToStaticMarkup(
      createElement(AppRecoveryPage, {
        title: "Cannot reach muxpilot",
        message: "The app is open, but the backend is not responding.",
        detail: "This can happen after the server restarts.",
        actionLabel: "Retry now",
        onAction: () => undefined
      })
    );

    expect(html).toContain('class="recovery-page"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Cannot reach muxpilot");
    expect(html).toContain("The app is open, but the backend is not responding.");
    expect(html).toContain("Retry now");
  });
});

describe("shouldShowConnectDeviceButton", () => {
  it("shows the connect button for trusted local access", () => {
    expect(shouldShowConnectDeviceButton({ accessGranted: true, accessKeyRequired: false, accessMode: "local" })).toBe(true);
  });

  it("hides the connect button for token access", () => {
    expect(shouldShowConnectDeviceButton({ accessGranted: true, accessKeyRequired: false, accessMode: "token" })).toBe(false);
  });

  it("hides the connect button unless local access is already granted without an access key", () => {
    expect(shouldShowConnectDeviceButton({ accessGranted: false, accessKeyRequired: true, accessMode: "token" })).toBe(false);
    expect(shouldShowConnectDeviceButton({ accessGranted: true, accessKeyRequired: true, accessMode: "local" })).toBe(false);
  });
});

describe("shouldShowLogoutButton", () => {
  it("shows logout for local and keyed remote access", () => {
    expect(shouldShowLogoutButton({ accessMode: "local" })).toBe(true);
    expect(shouldShowLogoutButton({ accessMode: "token" })).toBe(true);
  });

  it("hides logout for unrestricted remote access", () => {
    expect(shouldShowLogoutButton({ accessMode: "unrestricted" })).toBe(false);
  });
});

describe("ConnectDeviceContent", () => {
  it("renders the primary remote URL and protected access key controls", () => {
    const html = renderConnectDeviceContent(testRemoteAccess({ primaryUrl: "http://192.168.1.174:12778" }));

    expect(html).toContain("http://192.168.1.174:12778");
    expect(html).toContain('type="password"');
    expect(html).toContain('value="river-slate-42-orbit-copper-17"');
    expect(html).toContain("Show QR code");
    expect(html).toContain("Revoke remote access");
    expect(html).toContain("Allow unrestricted remote access");
  });

  it("renders unrestricted remote access without key controls", () => {
    const remoteAccess = testRemoteAccess({
      accessMode: "unrestricted",
      accessKeyRequired: false,
      unrestrictedRemoteAccess: true,
      primaryAccessUrl: "http://192.168.1.174:12778"
    });
    const html = renderConnectDeviceContent(remoteAccess);

    expect(remoteAccessQrValue(remoteAccess)).toBe("http://192.168.1.174:12778");
    expect(html).toContain("Unrestricted remote");
    expect(html).toContain("Remote devices will be able to connect without the access key.");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Copy key");
  });

  it("renders PWA trust controls when a trust URL is available", () => {
    const html = renderConnectDeviceContent(
      testRemoteAccess({
        pwaTrust: {
          available: true,
          port: 12880,
          primaryUrl: "http://192.168.1.174:12880/muxpilot-root-ca.crt",
          urls: ["http://192.168.1.174:12880/muxpilot-root-ca.crt"],
          warnings: []
        }
      })
    );

    expect(html).toContain("Install phone certificate");
    expect(html).toContain("http://192.168.1.174:12880/muxpilot-root-ca.crt");
    expect(html).toContain("Show certificate QR");
  });

  it("collapses the QR code by default and encodes the keyed access URL", () => {
    const remoteAccess = testRemoteAccess({
      primaryUrl: "http://192.168.1.174:12778",
      primaryAccessUrl: "http://192.168.1.174:12778/access?accessKey=river-slate-42-orbit-copper-17"
    });
    const html = renderConnectDeviceContent(remoteAccess);

    expect(remoteAccessQrValue(remoteAccess)).toBe("http://192.168.1.174:12778/access?accessKey=river-slate-42-orbit-copper-17");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("QR code for");
  });

  it("does not render a QR code when phone access is unavailable", () => {
    const html = renderConnectDeviceContent(testRemoteAccess({ primaryUrl: null, primaryAccessUrl: null, urls: [], accessUrls: [] }));

    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("QR code for");
    expect(html).toContain("Phone access is not available with the current bind settings.");
  });
});

describe("directorySuggestionLabel", () => {
  it("labels suggestions with branch and source when available", () => {
    expect(
      directorySuggestionLabel({
        path: "/repo",
        label: "muxpilot",
        repoRoot: "/repo",
        branch: "main",
        source: "active",
        lastActivityAt: "2026-07-08T00:00:00.000Z"
      })
    ).toBe("muxpilot · main · active");
  });

  it("omits the branch segment when no branch is known", () => {
    expect(
      directorySuggestionLabel({
        path: "/repo",
        label: "repo",
        repoRoot: null,
        branch: null,
        source: "recent",
        lastActivityAt: null
      })
    ).toBe("repo · recent");
  });
});

describe("filterSessionDirectorySuggestions", () => {
  const suggestions = [
    directorySuggestion({ path: "/home/dev/muxpilot", label: "muxpilot", branch: "main", source: "active", lastActivityAt: "2026-07-08T09:00:00.000Z" }),
    directorySuggestion({ path: "/home/dev/teamweave", label: "teamweave", branch: "stage", source: "recent", lastActivityAt: "2026-07-08T10:00:00.000Z" }),
    directorySuggestion({ path: "/tmp/scratch", label: "scratch", branch: null, source: "recent", lastActivityAt: null })
  ];

  it("returns newest suggestions when the directory input is empty", () => {
    expect(filterSessionDirectorySuggestions(suggestions, "", 2).map((suggestion) => suggestion.path)).toEqual([
      "/home/dev/teamweave",
      "/home/dev/muxpilot"
    ]);
  });

  it("filters suggestions by label, branch, repo root, or path", () => {
    expect(filterSessionDirectorySuggestions(suggestions, "team").map((suggestion) => suggestion.path)).toEqual(["/home/dev/teamweave"]);
    expect(filterSessionDirectorySuggestions(suggestions, "main").map((suggestion) => suggestion.path)).toEqual(["/home/dev/muxpilot"]);
    expect(filterSessionDirectorySuggestions(suggestions, "/tmp").map((suggestion) => suggestion.path)).toEqual(["/tmp/scratch"]);
  });
});

describe("sessionDirectorySuggestionsFromSessions", () => {
  it("returns active directory suggestions from the already loaded sessions", () => {
    const suggestions = sessionDirectorySuggestionsFromSessions([
      testSession({
        id: "a",
        repoRoot: "/home/dev/muxpilot",
        repoName: "muxpilot",
        branch: "main",
        cwd: "/home/dev/muxpilot/apps/web",
        lastActivityAt: "2026-07-08T11:00:00.000Z"
      }),
      testSession({
        id: "b",
        repoRoot: null,
        repoName: "scratch",
        branch: null,
        cwd: "/tmp/scratch",
        lastActivityAt: "2026-07-08T10:00:00.000Z"
      })
    ]);

    expect(suggestions).toEqual([
      {
        path: "/home/dev/muxpilot",
        label: "muxpilot",
        repoRoot: "/home/dev/muxpilot",
        branch: "main",
        source: "active",
        lastActivityAt: "2026-07-08T11:00:00.000Z"
      },
      {
        path: "/tmp/scratch",
        label: "scratch",
        repoRoot: null,
        branch: null,
        source: "active",
        lastActivityAt: "2026-07-08T10:00:00.000Z"
      }
    ]);
  });

  it("ignores archived or missing sessions", () => {
    expect(
      sessionDirectorySuggestionsFromSessions([
        testSession({ id: "archived", archived: true, repoRoot: "/repo/a" }),
        testSession({ id: "missing", status: "missing", repoRoot: "/repo/b" })
      ])
    ).toEqual([]);
  });
});

describe("mergeSessionDirectorySuggestions", () => {
  it("keeps active suggestions ahead of duplicate recent suggestions while preserving the latest activity time", () => {
    expect(
      mergeSessionDirectorySuggestions(
        [directorySuggestion({ path: "/repo", label: "repo", branch: "main", source: "active", lastActivityAt: "2026-07-08T09:00:00.000Z" })],
        [directorySuggestion({ path: "/repo", label: "repo", branch: "dev", source: "recent", lastActivityAt: "2026-07-08T12:00:00.000Z" })]
      )
    ).toEqual([
      {
        path: "/repo",
        label: "repo",
        repoRoot: "/repo",
        branch: "main",
        source: "active",
        lastActivityAt: "2026-07-08T12:00:00.000Z"
      }
    ]);
  });
});

describe("sessionNameValidationMessage", () => {
  it("allows names that normalize to a valid session slug", () => {
    expect(sessionNameValidationMessage("New Work")).toBeNull();
    expect(sessionNameValidationMessage("ready-2")).toBeNull();
  });

  it("does not warn for empty or too-short normalized names", () => {
    expect(sessionNameValidationMessage("")).toBeNull();
    expect(sessionNameValidationMessage("a")).toBeNull();
    expect(sessionNameValidationMessage("!!!")).toBeNull();
  });
});

describe("SessionStoplight", () => {
  it("renders red yellow green counters with accessible labels", () => {
    const html = renderToStaticMarkup(createElement(SessionStoplight, { counts: { red: 3, yellow: 2, green: 1 }, activeSeverity: "yellow" }));

    expect(html).toContain('class="session-stoplight-dot session-stoplight-dot-red"');
    expect(html).toContain('class="session-stoplight-dot session-stoplight-dot-yellow"');
    expect(html).toContain('class="session-stoplight-dot session-stoplight-dot-green"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-label="3 sessions need attention"');
    expect(html).toContain('aria-label="2 sessions working"');
    expect(html).toContain('aria-label="1 session ready"');
    expect(html).toContain(">3</button>");
    expect(html).toContain(">2</button>");
    expect(html).toContain(">1</button>");
  });

  it("hides stoplight counters whose count is zero", () => {
    const html = renderToStaticMarkup(createElement(SessionStoplight, { counts: { red: 0, yellow: 2, green: 0 } }));

    expect(html).not.toContain("session-stoplight-dot-red");
    expect(html).toContain("session-stoplight-dot-yellow");
    expect(html).not.toContain("session-stoplight-dot-green");
    expect(html).not.toContain(">0</button>");
    expect(html).toContain(">2</button>");
  });
});

describe("nextSessionStoplightSearch", () => {
  it("parses the active stoplight severity", () => {
    expect(activeSessionStoplightSeverity("?statusSeverity=red")).toBe("red");
    expect(activeSessionStoplightSeverity("?statusSeverity=blue")).toBeNull();
    expect(activeSessionStoplightSeverity("")).toBeNull();
  });

  it("applies a stoplight severity when none is active", () => {
    expect(nextSessionStoplightSearch("", "yellow")).toBe("?statusSeverity=yellow");
  });

  it("clears the stoplight severity when the active severity is selected again", () => {
    expect(nextSessionStoplightSearch("?statusSeverity=yellow", "yellow")).toBe("");
  });

  it("switches from the active severity to a different severity", () => {
    expect(nextSessionStoplightSearch("?statusSeverity=yellow", "red")).toBe("?statusSeverity=red");
  });

  it("replaces individual status filters with the selected stoplight severity", () => {
    expect(nextSessionStoplightSearch("?status=waiting", "red")).toBe("?statusSeverity=red");
  });

  it("preserves unrelated query params while toggling severity filters", () => {
    expect(nextSessionStoplightSearch("?q=session&statusSeverity=yellow", "yellow")).toBe("?q=session");
    expect(nextSessionStoplightSearch("?q=session", "green")).toBe("?q=session&statusSeverity=green");
  });
});

describe("syncSessionIntoStoplightSessions", () => {
  it("adds and replaces chat-refreshed sessions in the stoplight list", () => {
    const first = testSession({ id: "a", status: "waiting" });
    const replacement = testSession({ id: "a", status: "approval" });
    const second = testSession({ id: "b", status: "working" });

    expect(syncSessionIntoStoplightSessions([], first)).toEqual([first]);
    expect(syncSessionIntoStoplightSessions([first], replacement)).toEqual([replacement]);
    expect(syncSessionIntoStoplightSessions([replacement], second)).toEqual([replacement, second]);
  });

  it("removes missing or archived sessions from the stoplight list", () => {
    const first = testSession({ id: "a", status: "waiting" });
    const second = testSession({ id: "b", status: "working" });

    expect(syncSessionIntoStoplightSessions([first, second], testSession({ id: "a", status: "missing" }))).toEqual([second]);
    expect(syncSessionIntoStoplightSessions([first, second], testSession({ id: "b", archived: true }))).toEqual([first]);
  });
});

function renderConnectDeviceContent(remoteAccess: RemoteAccessResponse): string {
  return renderToStaticMarkup(
    createElement(ConnectDeviceContent, {
      remoteAccess,
      copiedValue: null,
      revokeBusy: false,
      settingsBusy: false,
      onCopy: () => undefined,
      onRevoke: () => undefined,
      onUpdateUnrestrictedRemoteAccess: () => undefined
    })
  );
}

function testRemoteAccess(input: Partial<RemoteAccessResponse> = {}): RemoteAccessResponse {
  const primaryUrl = input.primaryUrl === undefined ? "http://192.168.1.174:12778" : input.primaryUrl;
  const accessKey = input.accessKey ?? "river-slate-42-orbit-copper-17";
  const primaryAccessUrl =
    input.primaryAccessUrl === undefined && primaryUrl ? `${primaryUrl}/access?accessKey=${accessKey}` : (input.primaryAccessUrl ?? null);
  return {
    bindHost: "0.0.0.0",
    webProtocol: "http",
    backendPort: 12777,
    webPort: 12778,
    accessMode: "token",
    accessKeyRequired: true,
    unrestrictedRemoteAccess: false,
    phoneAccessAvailable: primaryUrl !== null,
    primaryUrl,
    primaryAccessUrl,
    accessKey,
    urls: primaryUrl ? [primaryUrl] : [],
    accessUrls: primaryAccessUrl ? [primaryAccessUrl] : [],
    pwaTrust: {
      available: false,
      port: null,
      primaryUrl: null,
      urls: [],
      warnings: []
    },
    lanAddresses: ["192.168.1.174"],
    warnings: [],
    ...input
  };
}

function directorySuggestion(input: {
  path: string;
  label: string;
  branch: string | null;
  source: SessionDirectorySuggestion["source"];
  lastActivityAt?: string | null;
}): SessionDirectorySuggestion {
  return {
    path: input.path,
    label: input.label,
    repoRoot: input.path,
    branch: input.branch,
    source: input.source,
    lastActivityAt: input.lastActivityAt ?? null
  };
}

function testSession(
  input: { id: string } & Partial<Pick<ManagedSession, "status" | "archived" | "lastActivityAt">> & {
      cwd?: string;
      repoRoot?: string | null;
      repoName?: string;
      branch?: string | null;
    }
): ManagedSession {
  return {
    id: input.id,
    tmux: {
      sessionId: "tmux-session",
      sessionName: "work",
      windowId: "@1",
      windowIndex: 1,
      windowName: "muxpilot",
      paneId: "%1",
      paneIndex: 0,
      paneActive: true,
      cwd: input.cwd ?? "/repo",
      currentCommand: "node",
      title: "muxpilot",
      pid: 123,
      size: "120x40"
    },
    repo: {
      root: input.repoRoot === undefined ? "/repo" : input.repoRoot,
      name: input.repoName ?? "repo",
      branch: input.branch === undefined ? "main" : input.branch,
      dirty: false,
      worktree: null
    },
    codexSessionId: null,
    codexJsonlPath: null,
    discoveryConfidence: "medium",
    status: input.status ?? "waiting",
    lastActivityAt: input.lastActivityAt ?? null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    archived: input.archived ?? false
  };
}
