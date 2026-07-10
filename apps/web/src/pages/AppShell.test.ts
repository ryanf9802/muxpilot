import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagedSession, RemoteAccessResponse, SessionDirectorySuggestion } from "@muxpilot/core";
import {
  AppBrand,
  AppRecoveryPage,
  ConnectDeviceContent,
  DisconnectedNotice,
  GitWorkflowSkillStatusCallout,
  SHELL_RECONNECT_INTERVAL_MS,
  SessionStoplight,
  filterSessionDirectorySuggestions,
  hasShortcutBlockingOverlay,
  isMuxpilotManagedSessionBranch,
  isEditableShortcutTarget,
  isNewSessionShortcut,
  isPrimaryInputFocusShortcut,
  isPromptHistoryShortcut,
  mergeSessionDirectorySuggestions,
  nextSessionDirectorySuggestionIndex,
  nextSessionStoplightSeverity,
  sessionStoplightSearch,
  parseGitRevisionInput,
  preferredGitRemote,
  sourceRevisionSuggestions,
  targetBranchSuggestions,
  primaryInputFocusCommandForShortcut,
  promptHistoryResultMeta,
  remoteAccessQrValue,
  sessionHistoryResultKey,
  sessionHistoryResultMeta,
  sessionDirectorySuggestionsFromSessions,
  sessionNameValidationMessage,
  shouldHandlePrimaryInputFocusShortcut,
  shouldShowConnectDeviceButton,
  shouldShowLogoutButton,
  shouldProbeShellConnection,
  syncSessionIntoStoplightSessions
} from "./AppShell.js";
import { directorySuggestionLabel } from "../utils/sessionDirectories.js";
import { ApiError } from "../api/client.js";

describe("shell connection state", () => {
  it("parses explicit and default-remote revision inputs without using the current checkout", () => {
    expect(parseGitRevisionInput("origin/stage", "origin")).toEqual({ kind: "remote_branch", remote: "origin", branch: "stage" });
    expect(parseGitRevisionInput("main", "origin")).toEqual({ kind: "remote_branch", remote: "origin", branch: "main" });
    expect(parseGitRevisionInput("local:release", "origin")).toEqual({ kind: "local_branch", branch: "release" });
  });
  it("formats target and source autocomplete values without collapsing revision concepts", () => {
    const probe = {
      isGit: true,
      bare: false,
      incompatibleReason: null,
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      dirty: false,
      remotes: ["origin", "upstream"],
      defaultRemote: "origin",
      localBranches: [
        "main",
        "local-only",
        "muxpilot/1234567890ABCDEF/g1",
        "muxpilot/1234567890ABCDEF",
        "muxpilot/feature"
      ],
      remoteBranches: [
        { remote: "origin", branch: "main" },
        { remote: "origin", branch: "stage" },
        { remote: "upstream", branch: "release" }
      ],
      tags: ["v1.0.0"]
    };

    expect(targetBranchSuggestions(probe, "origin")).toEqual([
      { value: "local-only", label: "local-only", detail: "Local branch" },
      { value: "main", label: "main", detail: "Local branch" },
      { value: "muxpilot/feature", label: "muxpilot/feature", detail: "Local branch" },
      { value: "stage", label: "stage", detail: "origin remote branch" }
    ]);
    expect(sourceRevisionSuggestions(probe, "origin").map((item) => item.value)).toEqual([
      "origin/main",
      "origin/stage",
      "local:local-only",
      "local:main",
      "local:muxpilot/feature",
      "upstream/release",
      "tag:v1.0.0"
    ]);
  });
  it("recognizes current and legacy managed branches without hiding ordinary muxpilot branches", () => {
    expect(isMuxpilotManagedSessionBranch("muxpilot/1234567890ABCDEF/g12")).toBe(true);
    expect(isMuxpilotManagedSessionBranch("muxpilot/1234567890ABCDEF")).toBe(true);
    expect(isMuxpilotManagedSessionBranch("muxpilot/feature")).toBe(false);
    expect(isMuxpilotManagedSessionBranch("muxpilot/1234567890ABCDEF/review")).toBe(false);
  });
  it("selects origin automatically, then the first available remote", () => {
    expect(preferredGitRemote({ remotes: ["upstream", "origin"] })).toBe("origin");
    expect(preferredGitRemote({ remotes: ["upstream", "backup"] })).toBe("upstream");
    expect(preferredGitRemote({ remotes: [] })).toBeNull();
  });
  it("renders the app logo next to the wordmark", () => {
    const html = renderToStaticMarkup(createElement(AppBrand));

    expect(html).toContain('class="brand-logo"');
    expect(html).toContain('src="/favicon.svg"');
    expect(html).toContain("<strong>muxpilot</strong>");
  });

  it("uses a short reconnect interval for transient disconnects", () => {
    expect(SHELL_RECONNECT_INTERVAL_MS).toBe(2000);
  });

  it("only probes connectivity for failures that did not receive an HTTP response", () => {
    expect(shouldProbeShellConnection(new ApiError("Conflict", 409))).toBe(false);
    expect(shouldProbeShellConnection(new ApiError("Server error", 500))).toBe(false);
    expect(shouldProbeShellConnection(new TypeError("Failed to fetch"))).toBe(true);
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

describe("GitWorkflowSkillStatusCallout", () => {
  it("directs missing and outdated skills to production startup without a manual action", () => {
    for (const status of ["missing", "outdated"] as const) {
      const html = renderToStaticMarkup(createElement(GitWorkflowSkillStatusCallout, { status, onRetry: () => undefined }));
      expect(html).toContain("pnpm app start prod");
      expect(html).not.toContain("<button");
    }
  });

  it("renders checking and retry states while current status stays hidden", () => {
    expect(renderToStaticMarkup(createElement(GitWorkflowSkillStatusCallout, { status: "checking", onRetry: () => undefined }))).toContain("Checking Codex skill");
    expect(renderToStaticMarkup(createElement(GitWorkflowSkillStatusCallout, { status: "error", onRetry: () => undefined }))).toContain("Retry");
    expect(renderToStaticMarkup(createElement(GitWorkflowSkillStatusCallout, { status: "current", onRetry: () => undefined }))).toBe("");
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

describe("prompt history helpers", () => {
  it("recognizes Ctrl+R without browser shortcut modifiers", () => {
    expect(isPromptHistoryShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "r" })).toBe(true);
    expect(isPromptHistoryShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "R" })).toBe(true);
    expect(isPromptHistoryShortcut({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: "r" })).toBe(false);
    expect(isPromptHistoryShortcut({ ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, key: "r" })).toBe(false);
  });

  it("formats prompt history result metadata with repo, branch, session, and time", () => {
    const meta = promptHistoryResultMeta({
      repoName: "muxpilot",
      repoBranch: "main",
      sessionName: "codex",
      timestamp: "2026-07-08T12:34:00.000Z"
    });

    expect(meta).toContain("muxpilot · main · codex");
  });
});

describe("session history helpers", () => {
  const managed = {
    sessionId: "pane-1",
    codexSessionId: "codex-1",
    repoName: "muxpilot",
    repoBranch: "main",
    cwd: "/repo",
    lastActivityAt: "2026-07-08T12:34:00.000Z",
    status: "missing" as const,
    archived: false,
    gitWorkspace: {
      id: "1234567890ABCDEF",
      worktreePath: "/worktrees/1234567890ABCDEF",
      sessionBranch: "muxpilot/1234567890ABCDEF/g2",
      targetBranch: "main"
    }
  };

  it("labels and keys managed results by their associated workspace", () => {
    expect(sessionHistoryResultMeta(managed)).toContain("muxpilot · muxpilot/1234567890ABCDEF/g2");
    expect(sessionHistoryResultKey(managed)).toBe("workspace:1234567890ABCDEF");
  });

  it("falls back to Codex identity for unmanaged results", () => {
    expect(sessionHistoryResultKey({ ...managed, gitWorkspace: null })).toBe("codex:codex-1");
  });
});

describe("new session shortcut helpers", () => {
  it("recognizes Ctrl+N without browser shortcut modifiers", () => {
    expect(isNewSessionShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "n" })).toBe(true);
    expect(isNewSessionShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "N" })).toBe(true);
    expect(isNewSessionShortcut({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: "n" })).toBe(false);
    expect(isNewSessionShortcut({ ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, key: "n" })).toBe(false);
    expect(isNewSessionShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, key: "n" })).toBe(false);
    expect(isNewSessionShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "r" })).toBe(false);
  });
});

describe("primary input focus shortcut helpers", () => {
  it("maps primary input shortcuts without browser shortcut modifiers", () => {
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "r" })).toBeNull();
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "R" })).toBeNull();
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "i" })).toBe("insert");
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "I" })).toBe(
      "insertStart"
    );
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, key: "I" })).toBe(
      "insertStart"
    );
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "a" })).toBe("append");
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "A" })).toBe("appendEnd");
    expect(primaryInputFocusCommandForShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, key: "A" })).toBe("appendEnd");
  });

  it("recognizes only unmodified primary input shortcut keys", () => {
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "r" })).toBe(false);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "i" })).toBe(true);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "I" })).toBe(true);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, key: "I" })).toBe(true);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "a" })).toBe(true);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "A" })).toBe(true);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, key: "A" })).toBe(true);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: "r" })).toBe(false);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: "r" })).toBe(false);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, key: "r" })).toBe(false);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, key: "i" })).toBe(false);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, key: "a" })).toBe(false);
    expect(isPrimaryInputFocusShortcut({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "x" })).toBe(false);
  });

  it("does not handle primary input shortcuts while typing in editable targets", () => {
    const input = shortcutTarget("input");
    const textarea = shortcutTarget("textarea");
    const codeMirrorContent = shortcutTarget(".cm-content");

    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(textarea)).toBe(true);
    expect(isEditableShortcutTarget(codeMirrorContent)).toBe(true);
    expect(
      shouldHandlePrimaryInputFocusShortcut(
        { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "i", target: input },
        null
      )
    ).toBe(false);
  });

  it("does not handle primary input shortcuts while dialogs or menus are open", () => {
    const ownerDocument = {
      querySelector: (selector: string) => (selector === "[role='dialog'], [role='menu']" ? {} : null)
    } as Pick<Document, "querySelector">;

    expect(hasShortcutBlockingOverlay(ownerDocument)).toBe(true);
    expect(
      shouldHandlePrimaryInputFocusShortcut(
        { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "A", target: null },
        ownerDocument
      )
    ).toBe(false);
  });

  it("handles primary input shortcuts when focus is outside editable targets and overlays", () => {
    const ownerDocument = { querySelector: () => null } as unknown as Pick<Document, "querySelector">;

    expect(
      shouldHandlePrimaryInputFocusShortcut(
        { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "a", target: shortcutTarget(null) },
        ownerDocument
      )
    ).toBe(true);
  });
});

function shortcutTarget(match: string | null): EventTarget {
  return {
    closest: (selector: string) => (match && selector.includes(match) ? {} : null)
  } as unknown as EventTarget;
}

describe("ConnectDeviceContent", () => {
  it("renders the primary remote URL and protected access key controls", () => {
    const html = renderConnectDeviceContent(testRemoteAccess({ primaryUrl: "http://192.168.1.174:12778" }));

    expect(html).toContain("http://192.168.1.174:12778");
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('autoCorrect="off"');
    expect(html).toContain('autoCapitalize="none"');
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

describe("nextSessionDirectorySuggestionIndex", () => {
  it("moves through directory suggestions with wrapping arrow-key semantics", () => {
    expect(nextSessionDirectorySuggestionIndex(0, 3, 1)).toBe(1);
    expect(nextSessionDirectorySuggestionIndex(2, 3, 1)).toBe(0);
    expect(nextSessionDirectorySuggestionIndex(0, 3, -1)).toBe(2);
    expect(nextSessionDirectorySuggestionIndex(1, 3, -1)).toBe(0);
  });

  it("keeps an empty suggestion list anchored at zero", () => {
    expect(nextSessionDirectorySuggestionIndex(2, 0, 1)).toBe(0);
    expect(nextSessionDirectorySuggestionIndex(2, 0, -1)).toBe(0);
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
    expect(html).toContain('data-has-active="true"');
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

  it("keeps the selected counter available when its count falls to zero", () => {
    const html = renderToStaticMarkup(createElement(SessionStoplight, { counts: { red: 0, yellow: 2, green: 0 }, activeSeverity: "red" }));

    expect(html).toContain("session-stoplight-dot-red");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">0</button>");
  });
});

describe("sessionStoplightSearch", () => {
  it("removes persisted status filters without adding stoplight state to the URL", () => {
    expect(sessionStoplightSearch("?status=waiting")).toBe("");
    expect(sessionStoplightSearch("?statusSeverity=yellow")).toBe("");
  });

  it("preserves unrelated query params", () => {
    expect(sessionStoplightSearch("?q=session&statusSeverity=yellow")).toBe("?q=session");
    expect(sessionStoplightSearch("?q=session")).toBe("?q=session");
  });
});

describe("nextSessionStoplightSeverity", () => {
  it("selects, switches, and toggles off quick-view severities", () => {
    expect(nextSessionStoplightSeverity(null, "yellow")).toBe("yellow");
    expect(nextSessionStoplightSeverity("yellow", "red")).toBe("red");
    expect(nextSessionStoplightSeverity("red", "red")).toBeNull();
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
    pinned: false,
    archived: input.archived ?? false
  };
}
