import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitWorkspaceState, ManagedSession } from "@muxpilot/core";
import {
  CodexUsagePanel,
  DASHBOARD_EVENT_DEBOUNCE_MS,
  DASHBOARD_SESSION_RECONCILE_INTERVAL_MS,
  DASHBOARD_STATUSES,
  DASHBOARD_USAGE_RECONCILE_INTERVAL_MS,
  dashboardLocationState,
  dashboardPreviewLines,
  dashboardStatusFilterFromSearchParams,
  filterSessionsByDashboardStatus,
  groupSessionsByRepo,
  OpenAIUsagePanel,
  orderSessionsWithinRepo,
  parseStoredCollapsedRepoKeys,
  RepoSessionGroupHeader,
  removeSessionFromDashboard,
  removeSessionsFromDashboard,
  SessionCard,
  sessionNameValidationMessage,
  shouldRefreshDashboardForEvent
} from "./Dashboard.js";
import { sessionDisplayName } from "../utils/sessionLabels.js";

describe("DASHBOARD_STATUSES", () => {
  it("includes plan-specific filter options", () => {
    expect(DASHBOARD_STATUSES).toContain("planning");
    expect(DASHBOARD_STATUSES).toContain("plan_ready");
  });
});

describe("dashboard refresh cadence", () => {
  it("keeps idle polling slower than event-driven session refreshes", () => {
    expect(DASHBOARD_EVENT_DEBOUNCE_MS).toBe(2000);
    expect(DASHBOARD_SESSION_RECONCILE_INTERVAL_MS).toBe(10_000);
    expect(DASHBOARD_USAGE_RECONCILE_INTERVAL_MS).toBe(60_000);
  });
});

describe("sessionDisplayName", () => {
  it("adds tmux identity details for duplicate default node windows", () => {
    const sessions = [testSession({ id: "a", paneId: "%111", windowName: "node" }), testSession({ id: "b", paneId: "%112", windowName: "node" })];

    expect(sessionDisplayName(sessions[0]!, sessions)).toBe("node · work:111.0 %111");
    expect(sessionDisplayName(sessions[1]!, sessions)).toBe("node · work:112.0 %112");
  });

  it("adds tmux identity details for a single generic node window", () => {
    const session = testSession({ id: "a", paneId: "%111", windowName: "node" });

    expect(sessionDisplayName(session, [session])).toBe("node · work:111.0 %111");
  });

  it("keeps a unique renamed session title clean", () => {
    const session = testSession({ id: "a", paneId: "%111", windowName: "plan-actions" });

    expect(sessionDisplayName(session, [session])).toBe("plan-actions");
  });
});

describe("sessionNameValidationMessage", () => {
  it("allows names that normalize to a valid session slug", () => {
    expect(sessionNameValidationMessage("My Session")).toBeNull();
    expect(sessionNameValidationMessage("ready-2")).toBeNull();
  });

  it("does not warn for empty or too-short normalized names", () => {
    expect(sessionNameValidationMessage("")).toBeNull();
    expect(sessionNameValidationMessage("a")).toBeNull();
    expect(sessionNameValidationMessage("!!!")).toBeNull();
  });
});

describe("SessionCard", () => {
  it("lets prompt preview height follow the rendered prompt lines", () => {
    const twoPrompts = testSession({
      id: "a",
      paneId: "%111",
      windowName: "two-prompts",
      recentUserPrompts: ["latest prompt", "second latest prompt"]
    });
    const onePrompt = testSession({
      id: "b",
      paneId: "%112",
      windowName: "one-prompt",
      recentUserPrompts: ["latest prompt"]
    });
    const summarized = testSession({
      id: "c",
      paneId: "%113",
      windowName: "summarized",
      recentUserPrompts: ["latest prompt", "second latest prompt"],
      activitySummary: "OpenAI summary"
    });

    expect(renderSessionCard(twoPrompts)).toContain('class="preview"');
    expect(renderSessionCard(twoPrompts)).not.toContain("preview-two-lines");
    expect(renderSessionCard(onePrompt)).toContain('class="preview"');
    expect(renderSessionCard(summarized)).toContain('class="preview"');
  });

  it("does not repeat repo branch metadata on each card", () => {
    const session = testSession({ id: "a", paneId: "%111", windowName: "muxpilot" });
    session.repo.dirty = true;

    const html = renderSessionCard(session);

    expect(html).not.toContain("main");
    expect(html).not.toContain("dirty");
  });

  it.each([
    ["idle", "idle"],
    ["worktree", "isolated"],
    ["integrating", "integrating"],
    ["blocked", "blocked"],
    ["failed", "failed"]
  ] satisfies [GitWorkspaceState, string][])('renders the %s Git workspace as a footer indicator', (state, label) => {
    const session = testSession({
      id: state,
      paneId: "%118",
      windowName: state,
      gitWorkspace: {
        workflowVersion: 1,
        id: `workspace-${state}`,
        state,
        entryPath: "/repo",
        repoRoot: "/repo",
        targetBranch: "main",
        targetSha: "2222222222222222222222222222222222222222",
        sessionBranch: state === "idle" ? null : `muxpilot/${state}`,
        worktreePath: state === "idle" ? null : `/worktrees/${state}`,
        lastError: state === "blocked" || state === "failed" ? `${label} error` : null,
        updatedAt: "2026-07-11T00:00:00.000Z",
        dependencyLinks: []
      }
    });

    const html = renderSessionCard(session);
    expect(html).toContain("<p>main</p>");
    expect(html).not.toContain(`<p>main · ${label}</p>`);
    expect(html).toContain(`class="git-workspace-status-indicator" data-state="${state}"`);
    expect(html).toContain(`aria-label="Git workspace: main · ${label}"`);
  });

  it("renders the current target after a session retarget", () => {
    const session = testSession({
      id: "retargeted",
      paneId: "%120",
      windowName: "retargeted",
      gitWorkspace: {
        workflowVersion: 1,
        id: "workspace-retargeted",
        state: "idle",
        entryPath: "/repo",
        repoRoot: "/repo",
        targetBranch: "release",
        targetSha: "3333333333333333333333333333333333333333",
        sessionBranch: null,
        worktreePath: null,
        lastError: null,
        updatedAt: "2026-07-14T12:00:00.000Z",
        dependencyLinks: []
      }
    });

    const html = renderSessionCard(session);
    expect(html).toContain("<p>release</p>");
    expect(html).toContain('aria-label="Git workspace: release · idle"');
    expect(html).not.toContain("<p>main</p>");
  });

  it("renders obsolete workspace errors as a neutral target state", () => {
    const session = testSession({
      id: "legacy",
      paneId: "%119",
      windowName: "legacy",
      gitWorkspace: {
        id: "legacy-workspace",
        state: "error",
        targetBranch: "main",
        lastError: "Obsolete finalization error"
      } as unknown as ManagedSession["gitWorkspace"]
    });

    const html = renderSessionCard(session);
    expect(html).toContain("main · idle");
    expect(html).not.toContain("error");
    expect(html).not.toContain("Obsolete finalization error");
  });

  it("renders session notification state without global-only rules", () => {
    const session = testSession({ id: "a", paneId: "%111", windowName: "notify" });

    expect(renderSessionCard(session)).not.toContain("session-notification-indicator");
    expect(renderSessionCard(session, ["done_task"])).toContain("Notify: Done task");
    expect(renderSessionCard(session, ["done_task"], "green")).toContain("session-card-notification-ring-green");
  });

  it("marks pinned sessions", () => {
    const session = testSession({ id: "a", paneId: "%111", windowName: "pinned", pinned: true });

    expect(renderSessionCard(session)).toContain("session-card-pinned");
    expect(renderSessionCard(session)).toContain("Pinned session");
  });

  it("marks session cards as shared context-menu triggers", () => {
    expect(renderSessionCard(testSession({ id: "a", paneId: "%111", windowName: "context-menu" }))).toContain(
      'data-context-menu-trigger=""'
    );
  });
});

describe("dashboardPreviewLines", () => {
  it("falls back to recent prompts when activity summaries are disabled", () => {
    const session = testSession({
      id: "a",
      paneId: "%111",
      windowName: "summarized",
      recentUserPrompts: ["latest prompt", "second latest prompt"],
      activitySummary: "OpenAI summary"
    });

    expect(dashboardPreviewLines(session)).toEqual(["OpenAI summary"]);
    expect(dashboardPreviewLines(session, false)).toEqual(["latest prompt", "second latest prompt"]);
  });
});

describe("OpenAIUsagePanel", () => {
  it("renders the activity summary toggle as enabled by default", () => {
    const html = renderToStaticMarkup(createElement(OpenAIUsagePanel, { summary: openAIUsageSummary(true) }));

    expect(html).toContain("OpenAI cost, past 30 days");
    expect(html).toContain("Summaries");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("Activity summary API calls");
  });

  it("renders the activity summary toggle as paused when disabled", () => {
    const html = renderToStaticMarkup(createElement(OpenAIUsagePanel, { summary: openAIUsageSummary(false) }));

    expect(html).toContain("Activity summaries paused");
    expect(html).not.toContain("checked");
  });

  it("hides the OpenAI usage panel when OpenAI is not configured", () => {
    const html = renderToStaticMarkup(createElement(OpenAIUsagePanel, { summary: { ...openAIUsageSummary(true), configured: false } }));

    expect(html).toBe("");
  });
});

describe("RepoSessionGroupHeader", () => {
  it("renders repo metadata without a per-repo new session button", () => {
    const session = testSession({ id: "a", paneId: "%111", windowName: "muxpilot" });
    const html = renderToStaticMarkup(
      createElement(RepoSessionGroupHeader, {
        group: {
          key: "/repo",
          repoName: "muxpilot",
          repoRoot: "/repo",
          branch: "main",
          dirty: true,
          sessions: [session]
        },
        isCollapsed: false,
        sessionGridId: "repo-session-grid-repo",
        onToggleCollapsed: () => undefined
      })
    );

    expect(html).toContain("muxpilot");
    expect(html).toContain("main");
    expect(html).toContain('<span title="main">main</span>');
    expect(html).toContain("dirty");
    expect(html).not.toContain("/repo");
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Collapse muxpilot"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="repo-session-grid-repo"');
    expect(html).not.toContain('aria-label="New session for muxpilot"');
    expect(html).not.toContain('title="New session"');
  });

  it("labels collapsed repo groups as expandable", () => {
    const session = testSession({ id: "a", paneId: "%111", windowName: "muxpilot" });
    const html = renderToStaticMarkup(
      createElement(RepoSessionGroupHeader, {
        group: {
          key: "/repo",
          repoName: "muxpilot",
          repoRoot: "/repo",
          branch: "main",
          dirty: false,
          sessions: [session]
        },
        isCollapsed: true,
        sessionGridId: "repo-session-grid-repo",
        onToggleCollapsed: () => undefined
      })
    );

    expect(html).toContain('aria-label="Expand muxpilot"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="Expand repo"');
  });
});

describe("dashboard repo session ordering", () => {
  it("places pinned sessions first while preserving existing order within partitions", () => {
    const sessions = [
      testSession({ id: "newest-unpinned", paneId: "%111", windowName: "newest-unpinned" }),
      testSession({ id: "newest-pinned", paneId: "%112", windowName: "newest-pinned", pinned: true }),
      testSession({ id: "oldest-pinned", paneId: "%113", windowName: "oldest-pinned", pinned: true }),
      testSession({ id: "oldest-unpinned", paneId: "%114", windowName: "oldest-unpinned" })
    ];

    expect(orderSessionsWithinRepo(sessions).map((session) => session.id)).toEqual([
      "newest-pinned",
      "oldest-pinned",
      "newest-unpinned",
      "oldest-unpinned"
    ]);
  });

  it("orders sessions within each repo without changing repo group order", () => {
    const sessions = [
      testSession({ id: "repo-a-active", paneId: "%111", windowName: "repo-a-active", repoRoot: "/repo-a", repoName: "repo-a" }),
      testSession({ id: "repo-b-pinned", paneId: "%112", windowName: "repo-b-pinned", repoRoot: "/repo-b", repoName: "repo-b", pinned: true }),
      testSession({ id: "repo-a-pinned", paneId: "%113", windowName: "repo-a-pinned", repoRoot: "/repo-a", repoName: "repo-a", pinned: true })
    ];

    const groups = groupSessionsByRepo(sessions);

    expect(groups.map((group) => group.key)).toEqual(["/repo-a", "/repo-b"]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["repo-a-pinned", "repo-a-active"]);
    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(["repo-b-pinned"]);
  });
});

describe("CodexUsagePanel", () => {
  it("renders the account and Codex limit usage", () => {
    const html = renderToStaticMarkup(
      createElement(CodexUsagePanel, {
        summary: {
          available: true,
          error: null,
          refreshedAt: "2026-07-07T12:00:00.000Z",
          account: { kind: "chatgpt", email: "engineer@example.com", planType: "plus" },
          limits: {
            fiveHour: {
              label: "5h limit",
              limitName: "codex",
              usedPercent: 40,
              remainingPercent: 60,
              windowDurationMins: 300,
              resetsAt: 1_784_000_000
            },
            weekly: {
              label: "Weekly limit",
              limitName: "codex",
              usedPercent: 70,
              remainingPercent: 30,
              windowDurationMins: 10_080,
              resetsAt: 1_784_300_000
            }
          }
        }
      })
    );

    expect(html).toContain("Codex usage");
    expect(html).toContain("engineer@example.com");
    expect(html).toContain("plus");
    expect(html).not.toContain("40% used");
    expect(html).toContain("60% remaining");
    expect(html).toContain("width:60%");
    expect(html).toContain("30% remaining");
  });

  it("keeps the panel visible when Codex usage is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(CodexUsagePanel, {
        summary: {
          available: false,
          error: "Codex account authentication required.",
          refreshedAt: "2026-07-07T12:00:00.000Z",
          account: null,
          limits: { fiveHour: null, weekly: null }
        }
      })
    );

    expect(html).toContain("Codex account authentication required.");
    expect(html).toContain("Not signed in");
    expect(html).toContain("unavailable");
  });
});

describe("repo collapsed state storage", () => {
  it("ignores invalid stored order payloads", () => {
    expect(parseStoredCollapsedRepoKeys(null)).toEqual([]);
    expect(parseStoredCollapsedRepoKeys("{")).toEqual([]);
    expect(parseStoredCollapsedRepoKeys(JSON.stringify(["alpha", 12, "", "beta"]))).toEqual(["alpha", "beta"]);
  });
});

describe("dashboard status filters", () => {
  it("ignores legacy severity parameters and uses individual status filters", () => {
    expect(dashboardStatusFilterFromSearchParams(new URLSearchParams("statusSeverity=red"))).toEqual({
      kind: "all",
      selectValue: ""
    });
    expect(dashboardStatusFilterFromSearchParams(new URLSearchParams("statusSeverity=blue&status=waiting"))).toEqual({
      kind: "status",
      status: "waiting",
      selectValue: "waiting"
    });
    expect(dashboardStatusFilterFromSearchParams(new URLSearchParams("statusSeverity=blue&status=bogus"))).toEqual({
      kind: "all",
      selectValue: ""
    });
  });

  it("filters mixed sessions by stoplight severity", () => {
    const sessions = [
      testSession({ id: "a", paneId: "%111", windowName: "approval", status: "approval" }),
      testSession({ id: "b", paneId: "%112", windowName: "question", status: "question" }),
      testSession({ id: "c", paneId: "%113", windowName: "working", status: "working" }),
      testSession({ id: "d", paneId: "%114", windowName: "waiting", status: "waiting" })
    ];

    expect(
      filterSessionsByDashboardStatus(sessions, { kind: "severity", severity: "red", selectValue: "severity:red" }).map((session) => session.id)
    ).toEqual(["a", "b"]);
    expect(
      filterSessionsByDashboardStatus(sessions, { kind: "severity", severity: "yellow", selectValue: "severity:yellow" }).map(
        (session) => session.id
      )
    ).toEqual(["c"]);
    expect(
      filterSessionsByDashboardStatus(sessions, { kind: "severity", severity: "green", selectValue: "severity:green" }).map(
        (session) => session.id
      )
    ).toEqual(["d"]);
  });

  it("preserves non-severity filter results unchanged", () => {
    const sessions = [testSession({ id: "a", paneId: "%111", windowName: "waiting", status: "waiting" })];

    expect(filterSessionsByDashboardStatus(sessions, { kind: "status", status: "waiting", selectValue: "waiting" })).toBe(sessions);
    expect(filterSessionsByDashboardStatus(sessions, { kind: "all", selectValue: "" })).toBe(sessions);
  });
});

describe("shouldRefreshDashboardForEvent", () => {
  it("refreshes for session and message events", () => {
    expect(shouldRefreshDashboardForEvent({ type: "session.updated" })).toBe(true);
    expect(shouldRefreshDashboardForEvent({ type: "status.changed" })).toBe(true);
    expect(shouldRefreshDashboardForEvent({ type: "message.appended" })).toBe(true);
  });

  it("ignores events that do not affect dashboard session data", () => {
    expect(shouldRefreshDashboardForEvent({ type: "connected" })).toBe(false);
    expect(shouldRefreshDashboardForEvent({ type: "notification.created" })).toBe(false);
  });
});

describe("removeSessionFromDashboard", () => {
  it("removes the killed session from the local dashboard list", () => {
    const sessions = [
      testSession({ id: "a", paneId: "%111", windowName: "first" }),
      testSession({ id: "b", paneId: "%112", windowName: "second" })
    ];

    expect(removeSessionFromDashboard(sessions, "a").map((session) => session.id)).toEqual(["b"]);
  });

  it("keeps optimistically removed sessions hidden from refresh payloads", () => {
    const sessions = [
      testSession({ id: "a", paneId: "%111", windowName: "first" }),
      testSession({ id: "b", paneId: "%112", windowName: "second" }),
      testSession({ id: "c", paneId: "%113", windowName: "third" })
    ];

    expect(removeSessionsFromDashboard(sessions, new Set(["a", "c"])).map((session) => session.id)).toEqual(["b"]);
  });
});

describe("dashboardLocationState", () => {
  it("extracts the optimistically removed session id from router state", () => {
    expect(dashboardLocationState({ optimisticallyRemovedSessionId: "session-1" })).toEqual({
      optimisticallyRemovedSessionId: "session-1"
    });
  });

  it("ignores missing or invalid router state", () => {
    expect(dashboardLocationState(null)).toEqual({ optimisticallyRemovedSessionId: null });
    expect(dashboardLocationState({ optimisticallyRemovedSessionId: 123 })).toEqual({ optimisticallyRemovedSessionId: null });
  });
});

function renderSessionCard(
  session: ManagedSession,
  notificationRules: Parameters<typeof SessionCard>[0]["notificationRules"] = [],
  notificationRing: Parameters<typeof SessionCard>[0]["notificationRing"] = null
): string {
  return renderToStaticMarkup(
    createElement(SessionCard, {
      session,
      displayName: sessionBaseTestName(session),
      previewLines: dashboardPreviewLines(session),
      notificationRules,
      notificationRing,
      onOpen: () => undefined,
      onOpenMenu: () => undefined,
      onOpenMenuFromButton: () => undefined
    })
  );
}

function openAIUsageSummary(activitySummariesEnabled: boolean) {
  return {
    configured: true,
    activitySummariesEnabled,
    days: 30,
    points: [],
    totals: {
      requestCount: 2,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      totalTokens: 110,
      estimatedCostUsd: 0.001
    },
    unpricedModels: []
  };
}

function sessionBaseTestName(session: ManagedSession): string {
  return session.tmux.windowName;
}

function testSession(
  input: {
    id: string;
    paneId: string;
    windowName: string;
    repoRoot?: string;
    repoName?: string;
  } & Partial<Pick<ManagedSession, "recentUserPrompts" | "activitySummary" | "status" | "pinned" | "gitWorkspace">>
): ManagedSession {
  const windowIndex = Number(input.paneId.slice(1));
  return {
    id: input.id,
    tmux: {
      sessionId: "tmux-session",
      sessionName: "work",
      windowId: `@${windowIndex}`,
      windowIndex,
      windowName: input.windowName,
      paneId: input.paneId,
      paneIndex: 0,
      paneActive: true,
      cwd: "/repo",
      currentCommand: "node",
      title: input.windowName,
      pid: 123,
      size: "120x40"
    },
    repo: { root: input.repoRoot ?? "/repo", name: input.repoName ?? "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: null,
    codexJsonlPath: null,
    discoveryConfidence: "medium",
    status: input.status ?? "waiting",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: input.recentUserPrompts ?? [],
    activitySummary: input.activitySummary ?? null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: input.pinned ?? false,
    archived: false,
    gitWorkspace: input.gitWorkspace ?? null
  };
}
