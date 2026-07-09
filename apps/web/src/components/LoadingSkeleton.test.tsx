import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccessLoadingSkeleton,
  AppLoadingSkeleton,
  DashboardSessionsSkeleton,
  SessionLoadingSkeleton,
  UsagePanelSkeleton,
  loadingSkeletonVariantForPath
} from "./LoadingSkeleton.js";

describe("loading skeleton routing", () => {
  it("uses the chat scaffold only for session routes", () => {
    expect(loadingSkeletonVariantForPath("/sessions/session-a")).toBe("session");
    expect(loadingSkeletonVariantForPath("/")).toBe("dashboard");
    expect(loadingSkeletonVariantForPath("/access")).toBe("dashboard");
  });

  it("renders a full dashboard-shaped startup scaffold", () => {
    const html = renderToStaticMarkup(createElement(AppLoadingSkeleton, { variant: "dashboard" }));

    expect(html).toContain('class="app loading-app-skeleton"');
    expect(html).toContain('class="dashboard loading-dashboard-skeleton"');
    expect(html).toContain("Loading dashboard");
    expect(html).toContain('aria-busy="true"');
  });

  it("renders a full chat-shaped startup scaffold", () => {
    const html = renderToStaticMarkup(createElement(AppLoadingSkeleton, { variant: "session", label: "Restoring session" }));

    expect(html).toContain('class="session-view loading-session-skeleton"');
    expect(html).toContain("Restoring session");
    expect(html).toContain("loading-message-list");
    expect(html).toContain("loading-composer");
    expect(html).not.toContain("<button");
  });
});

describe("loading skeleton regions", () => {
  it("announces standalone chat and access loading states", () => {
    const sessionHtml = renderToStaticMarkup(createElement(SessionLoadingSkeleton));
    const accessHtml = renderToStaticMarkup(createElement(AccessLoadingSkeleton));

    expect(sessionHtml).toContain('role="status"');
    expect(sessionHtml).toContain("Loading session");
    expect(accessHtml).toContain('role="status"');
    expect(accessHtml).toContain("Checking access");
  });

  it("announces dashboard session and usage regions independently", () => {
    const sessionsHtml = renderToStaticMarkup(createElement(DashboardSessionsSkeleton));
    const usageHtml = renderToStaticMarkup(createElement(UsagePanelSkeleton, { chart: true }));

    expect(sessionsHtml).toContain("Loading sessions");
    expect(sessionsHtml).toContain('aria-busy="true"');
    expect(usageHtml).toContain("Loading usage");
    expect(usageHtml).toContain("skeleton-usage-chart");
  });
});
