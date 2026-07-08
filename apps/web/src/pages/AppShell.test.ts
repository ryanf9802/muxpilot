import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ManagedSession, RemoteAccessResponse } from "@muxpilot/core";
import {
  ConnectDeviceContent,
  DisconnectedNotice,
  SHELL_RECONNECT_INTERVAL_MS,
  SessionStoplight,
  remoteAccessQrValue,
  shouldShowConnectDeviceButton,
  syncSessionIntoStoplightSessions
} from "./AppShell.js";

describe("shell connection state", () => {
  it("uses a short reconnect interval for transient disconnects", () => {
    expect(SHELL_RECONNECT_INTERVAL_MS).toBe(2000);
  });

  it("renders a clear disconnected reconnecting notice", () => {
    const html = renderToStaticMarkup(createElement(DisconnectedNotice));

    expect(html).toContain('role="status"');
    expect(html).toContain("Disconnected from muxpilot. Reconnecting...");
    expect(html).toContain("spin");
  });
});

describe("shouldShowConnectDeviceButton", () => {
  it("shows the connect button for trusted local access", () => {
    expect(shouldShowConnectDeviceButton({ accessMode: "local" })).toBe(true);
  });

  it("hides the connect button for token access", () => {
    expect(shouldShowConnectDeviceButton({ accessMode: "token" })).toBe(false);
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

describe("SessionStoplight", () => {
  it("renders red yellow green counters with accessible labels", () => {
    const html = renderToStaticMarkup(createElement(SessionStoplight, { counts: { red: 3, yellow: 2, green: 1 } }));

    expect(html).toContain('class="session-stoplight-dot session-stoplight-dot-red"');
    expect(html).toContain('class="session-stoplight-dot session-stoplight-dot-yellow"');
    expect(html).toContain('class="session-stoplight-dot session-stoplight-dot-green"');
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

function testSession(input: { id: string } & Partial<Pick<ManagedSession, "status" | "archived">>): ManagedSession {
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
      cwd: "/repo",
      currentCommand: "node",
      title: "muxpilot",
      pid: 123,
      size: "120x40"
    },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: null,
    codexJsonlPath: null,
    discoveryConfidence: "medium",
    status: input.status ?? "waiting",
    lastActivityAt: null,
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
