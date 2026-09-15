// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { DocumentsButton, DocumentsModal, MessageBubble } from "./SessionView.js";

const copyTextMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../utils/clipboard.js", () => ({ copyText: copyTextMock }));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  copyTextMock.mockClear();
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("DocumentsModal", () => {
  it("opens a requested applied document instead of the default index", async () => {
    const documents = [
      { name: "INDEX.md", sizeBytes: 10, updatedAt: "2026-08-25T00:00:00.000Z" },
      { name: "plan.md", sizeBytes: 12, updatedAt: "2026-08-25T00:00:00.000Z" }
    ];
    const read = vi.spyOn(api, "sessionDocument").mockResolvedValue({
      document: { name: "plan.md", content: "# Requested plan", sizeBytes: 12, updatedAt: documents[1]!.updatedAt }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={documents} requestedDocument="plan.md" listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(read).toHaveBeenCalledWith("session-1", "plan.md");
    expect(container.querySelector("button[data-active='true'] strong")?.textContent).toBe("plan.md");
    act(() => root.unmount());
  });

  it("does not reapply a requested document after the user selects another document", async () => {
    const documents = [
      { name: "INDEX.md", sizeBytes: 10, updatedAt: "2026-08-25T00:00:00.000Z" },
      { name: "plan.md", sizeBytes: 12, updatedAt: "2026-08-25T00:00:00.000Z" }
    ];
    const read = vi.spyOn(api, "sessionDocument").mockImplementation(async (_sessionId, name) => ({
      document: { ...documents.find((document) => document.name === name)!, content: `# ${name}` }
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={documents} requestedDocument="plan.md" listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".documents-list button")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector("button[data-active='true'] strong")?.textContent).toBe("INDEX.md");

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={documents.map((document) => ({ ...document }))} requestedDocument="plan.md" listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
    });

    expect(read).toHaveBeenLastCalledWith("session-1", "INDEX.md");
    expect(container.querySelector("button[data-active='true'] strong")?.textContent).toBe("INDEX.md");
    act(() => root.unmount());
  });

  it("preserves viewer scroll when the selected document content refreshes", async () => {
    const initial = { name: "plan.md", sizeBytes: 12, updatedAt: "2026-08-25T00:00:00.000Z" };
    let readCount = 0;
    vi.spyOn(api, "sessionDocument").mockImplementation(async () => {
      readCount += 1;
      return { document: { ...initial, content: `# Revision ${readCount}` } };
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={[initial]} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const viewer = container.querySelector<HTMLElement>(".documents-viewer");
    if (viewer) viewer.scrollTop = 180;

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={[{ ...initial, updatedAt: "2026-08-25T00:01:00.000Z" }]} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readCount).toBe(2);
    expect(container.querySelector(".documents-viewer h1")?.textContent).toBe("Revision 2");
    expect(viewer?.scrollTop).toBe(180);
    act(() => root.unmount());
  });

  it("prefers INDEX.md and renders its Markdown read-only", async () => {
    const documents = [
      { name: "tasks.md", sizeBytes: 8, updatedAt: "2026-08-25T00:00:00.000Z" },
      { name: "INDEX.md", sizeBytes: 15, updatedAt: "2026-08-25T00:00:00.000Z" }
    ];
    const read = vi.spyOn(api, "sessionDocument").mockResolvedValue({
      document: { name: "INDEX.md", content: "# Durable plan", sizeBytes: 14, updatedAt: "2026-08-25T00:00:00.000Z" }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={documents} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(read).toHaveBeenCalledWith("session-1", "INDEX.md");
    expect(container.querySelector("h1")?.textContent).toBe("Durable plan");
    expect(container.querySelector("button[data-active='true'] strong")?.textContent).toBe("INDEX.md");
    act(() => root.unmount());
  });

  it("shows an empty state", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={[]} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("This session has no documents yet.");
    act(() => root.unmount());
  });

  it("opens narrow-screen navigation temporarily from the modal header", async () => {
    const documentSummary = { name: "plan.md", sizeBytes: 12, updatedAt: "2026-09-15T00:00:00.000Z" };
    vi.spyOn(api, "sessionDocument").mockResolvedValue({
      document: { ...documentSummary, content: "# Plan\n\n## Next step" }
    });
    const close = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={[documentSummary]} listLoading={false} listError="" onClose={close} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const navigationButton = container.querySelector<HTMLButtonElement>(".documents-mobile-nav-toggle");
    expect(navigationButton?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => navigationButton?.click());
    expect(navigationButton?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".documents-sidebar")?.getAttribute("data-mobile-open")).toBe("true");
    expect(container.querySelector(".documents-sidebar-backdrop")).not.toBeNull();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>(".documents-sidebar-toggle button"))
        .find((button) => button.textContent === "Outline")?.click();
    });
    expect(navigationButton?.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(navigationButton?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".documents-modal")).not.toBeNull();
    expect(close).not.toHaveBeenCalled();

    await act(async () => navigationButton?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".documents-sidebar-backdrop")?.click());
    expect(navigationButton?.getAttribute("aria-expanded")).toBe("false");
    act(() => root.unmount());
  });

  it("opens linked session documents in the viewer and leaves external links safe", async () => {
    const documents = [
      { name: "INDEX.md", sizeBytes: 80, updatedAt: "2026-08-25T00:00:00.000Z" },
      { name: "plan.md", sizeBytes: 20, updatedAt: "2026-08-25T00:00:00.000Z" }
    ];
    let resolvePlan!: (value: Awaited<ReturnType<typeof api.sessionDocument>>) => void;
    const planResponse = new Promise<Awaited<ReturnType<typeof api.sessionDocument>>>((resolve) => { resolvePlan = resolve; });
    const read = vi.spyOn(api, "sessionDocument").mockImplementation(async (_sessionId, name) => name === "INDEX.md"
      ? { document: { name, content: "[Plan](./plan.md#current-plan) [External](https://example.com)", sizeBytes: 62, updatedAt: documents[0]!.updatedAt } }
      : planResponse);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={documents} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const documentLink = container.querySelector<HTMLAnchorElement>('a[href="./plan.md#current-plan"]');
    const externalLink = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]');
    const viewer = container.querySelector<HTMLElement>(".documents-viewer");
    expect(documentLink?.target).toBe("");
    expect(externalLink?.target).toBe("_blank");
    expect(externalLink?.rel).toBe("noopener noreferrer");

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={documents.map((document) => ({ ...document }))} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
    });
    expect(container.querySelector('a[href="./plan.md#current-plan"]')).toBe(documentLink);
    expect(container.querySelector('a[href="https://example.com"]')).toBe(externalLink);

    if (viewer) viewer.scrollTop = 160;

    await act(async () => {
      documentLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(read).toHaveBeenLastCalledWith("session-1", "plan.md");
    expect(container.querySelector(".documents-viewer")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".documents-loading-indicator")?.textContent).toBe("Loading plan.md");
    expect(container.querySelector(".documents-viewer-content")?.textContent).toContain("Plan");
    expect(container.querySelector(".documents-viewer-content")?.getAttribute("data-loading")).toBe("true");
    expect(container.querySelector(".documents-viewer-content")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".documents-viewer")?.textContent).not.toContain("Loading plan.md…");
    expect(container.querySelector("button[data-active='true']")?.getAttribute("aria-current")).toBe("page");

    await act(async () => {
      resolvePlan({ document: { name: "plan.md", content: "## Current plan", sizeBytes: 15, updatedAt: documents[1]!.updatedAt } });
      await planResponse;
      await Promise.resolve();
    });

    expect(container.querySelector(".documents-viewer")?.hasAttribute("aria-busy")).toBe(false);
    expect(container.querySelector(".documents-loading-indicator")).toBeNull();
    const currentPlanHeading = container.querySelector<HTMLElement>(".documents-viewer h2");
    expect(currentPlanHeading?.textContent).toBe("Current plan");
    expect(currentPlanHeading?.id).toBe("current-plan");
    expect(currentPlanHeading?.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(container.querySelector("button[data-active='true'] strong")?.textContent).toBe("plan.md");
    act(() => root.unmount());
  });

  it("navigates a numbered table of contents within the current document", async () => {
    const documentSummary = { name: "brief.md", sizeBytes: 100, updatedAt: "2026-09-15T00:00:00.000Z" };
    vi.spyOn(api, "sessionDocument").mockResolvedValue({
      document: {
        ...documentSummary,
        content: [
          "# SMS legal review brief",
          "",
          "[Included use](#21-included-use)",
          "",
          "## 2.1 Included use",
          "",
          "## Repeated heading",
          "",
          "## Repeated heading"
        ].join("\n")
      }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={[documentSummary]} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(Array.from(container.querySelectorAll(".documents-viewer-content h2"), (heading) => heading.id)).toEqual([
      "21-included-use",
      "repeated-heading",
      "repeated-heading-1"
    ]);
    const target = document.getElementById("21-included-use");
    await act(async () => {
      container.querySelector<HTMLAnchorElement>('a[href="#21-included-use"]')?.click();
    });
    expect(target?.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>(".documents-sidebar-toggle button"))
        .find((button) => button.textContent === "Outline")?.click();
    });
    const outline = container.querySelector(".documents-outline");
    const outlineButtons = Array.from(outline?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(outline?.getAttribute("aria-label")).toBe("Outline for brief.md");
    expect(outlineButtons.map((button) => [button.textContent, button.dataset.level])).toEqual([
      ["SMS legal review brief", "1"],
      ["2.1 Included use", "2"],
      ["Repeated heading", "2"],
      ["Repeated heading", "2"]
    ]);

    const headings = Array.from(container.querySelectorAll<HTMLElement>(".documents-viewer-content h1, .documents-viewer-content h2"));
    headings.forEach((heading, index) => Object.defineProperty(heading, "offsetTop", { configurable: true, value: index * 120 }));
    const viewer = container.querySelector<HTMLElement>(".documents-viewer");
    if (viewer) viewer.scrollTop = 140;
    await act(async () => {
      viewer?.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(outline?.querySelector("button[aria-current='location']")?.textContent).toBe("2.1 Included use");

    await act(async () => {
      outlineButtons.at(-1)?.click();
    });
    expect(headings.at(-1)?.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(outlineButtons.at(-1)?.getAttribute("aria-current")).toBe("location");
    act(() => root.unmount());
  });

  it("reports a missing section without leaving the document viewer", async () => {
    const documentSummary = { name: "brief.md", sizeBytes: 50, updatedAt: "2026-09-15T00:00:00.000Z" };
    vi.spyOn(api, "sessionDocument").mockResolvedValue({
      document: { ...documentSummary, content: "[Missing](#missing-section) [Missing doc](missing.md)\n\n## Present section" }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" documents={[documentSummary]} listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLAnchorElement>('a[href="#missing-section"]')?.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Section #missing-section was not found in brief.md.");
    await act(async () => {
      container.querySelector<HTMLAnchorElement>('a[href="missing.md"]')?.click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Document missing.md was not found.");
    act(() => root.unmount());
  });

  it("shows cross-session context in the same modal and returns to current documents", async () => {
    const documents = [{ name: "plan.md", sizeBytes: 12, updatedAt: "2026-09-01T00:00:00.000Z" }];
    vi.spyOn(api, "sessionDocument").mockResolvedValue({
      document: { ...documents[0]!, content: "# Remote plan\n\n## Review items" }
    });
    const onReturnToCurrent = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DocumentsModal
          open
          sessionId="remote-session"
          sourceSessionName="performance"
          currentSession={false}
          documents={documents}
          requestedDocument="plan.md"
          requestedFragment="review-items"
          requestedNavigation={1}
          listLoading={false}
          listError=""
          onReturnToCurrent={onReturnToCurrent}
          onClose={() => undefined}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector(".documents-source-context")?.textContent).toContain("Viewing documents from performance");
    act(() => container.querySelector<HTMLButtonElement>(".documents-source-context button")?.click());
    expect(onReturnToCurrent).toHaveBeenCalledOnce();
    expect(container.querySelector(".documents-viewer h1")?.textContent).toBe("Remote plan");
    const reviewItems = document.getElementById("review-items");
    expect(reviewItems?.scrollIntoView).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <DocumentsModal
          open
          sessionId="remote-session"
          sourceSessionName="performance"
          currentSession={false}
          documents={documents}
          requestedDocument="plan.md"
          requestedFragment="review-items"
          requestedNavigation={2}
          listLoading={false}
          listError=""
          onReturnToCurrent={onReturnToCurrent}
          onClose={() => undefined}
        />
      );
      await Promise.resolve();
    });
    expect(reviewItems?.scrollIntoView).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("reloads the same document identity when the source session changes", async () => {
    const summary = { name: "plan.md", sizeBytes: 12, updatedAt: "2026-09-01T00:00:00.000Z" };
    const read = vi.spyOn(api, "sessionDocument").mockImplementation(async (sessionId) => ({
      document: { ...summary, content: sessionId === "session-a" ? "# Session A" : "# Session B" }
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-a" documents={[summary]} requestedDocument="plan.md" listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector(".documents-viewer h1")?.textContent).toBe("Session A");

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-b" documents={[summary]} requestedDocument="plan.md" listLoading={false} listError="" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(read).toHaveBeenLastCalledWith("session-b", "plan.md");
    expect(container.querySelector(".documents-viewer h1")?.textContent).toBe("Session B");
    act(() => root.unmount());
  });

  it("opens muxpilot document paths and copies other file paths without source locations", async () => {
    const openDocument = vi.fn(async () => true);
    const message = {
      id: "message-1",
      sessionId: "session-1",
      sequence: 1,
      type: "assistant" as const,
      role: "assistant" as const,
      timestamp: "2026-09-01T00:00:00.000Z",
      text: "[Document](/home/ryanf/.muxpilot/sessions/cgZiXQrkbVYonDQ5/documents/tw-1352-orchestrator-handoff-prompt.md:1) [Source](/workspace/My%20Project/app.ts:42:7) [Web](https://example.com)",
      payload: {}
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MessageBubble message={message} onOpenDocument={openDocument} />);
    });

    const documentLink = container.querySelector<HTMLAnchorElement>('a[href*="tw-1352-orchestrator"]');
    const sourceLink = container.querySelector<HTMLAnchorElement>('a[href*="app.ts"]');
    const webLink = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]');
    expect(sourceLink?.title).toBe("/workspace/My Project/app.ts");
    expect(webLink?.target).toBe("_blank");

    await act(async () => {
      documentLink?.click();
      await Promise.resolve();
    });
    expect(openDocument).toHaveBeenCalledWith({
      scopeId: "cgZiXQrkbVYonDQ5",
      name: "tw-1352-orchestrator-handoff-prompt.md",
      path: "/home/ryanf/.muxpilot/sessions/cgZiXQrkbVYonDQ5/documents/tw-1352-orchestrator-handoff-prompt.md"
    });
    expect(copyTextMock).not.toHaveBeenCalled();

    await act(async () => {
      sourceLink?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copyTextMock).toHaveBeenCalledWith("/workspace/My Project/app.ts");
    expect(sourceLink?.dataset.copied).toBe("true");
    act(() => root.unmount());
  });

  it("keeps document and web anchors mounted across passive transcript refreshes", async () => {
    const firstOpenDocument = vi.fn(async () => true);
    const latestOpenDocument = vi.fn(async () => true);
    const message = {
      id: "message-1",
      sessionId: "session-1",
      sequence: 1,
      type: "assistant" as const,
      role: "assistant" as const,
      timestamp: "2026-09-01T00:00:00.000Z",
      text: "[Document](/home/ryanf/.muxpilot/sessions/cgZiXQrkbVYonDQ5/documents/plan.md) [Web](https://example.com)",
      payload: {}
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MessageBubble message={message} onOpenDocument={firstOpenDocument} onOpenMenu={() => undefined} />);
    });
    const documentLink = container.querySelector<HTMLAnchorElement>('a[href*="/documents/plan.md"]');
    const webLink = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]');
    documentLink?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    await act(async () => {
      root.render(<MessageBubble message={{ ...message }} onOpenDocument={latestOpenDocument} onOpenMenu={() => undefined} />);
    });

    expect(container.querySelector('a[href*="/documents/plan.md"]')).toBe(documentLink);
    expect(container.querySelector('a[href="https://example.com"]')).toBe(webLink);
    const webClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    webLink?.dispatchEvent(webClick);
    expect(webClick.defaultPrevented).toBe(false);
    await act(async () => {
      documentLink?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      documentLink?.click();
      await Promise.resolve();
    });
    expect(firstOpenDocument).not.toHaveBeenCalled();
    expect(latestOpenDocument).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("renders the Documents button only when documents exist", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<DocumentsButton documentCount={0} open={false} onOpen={() => undefined} />));
    expect(container.querySelector("button")).toBeNull();

    act(() => root.render(<DocumentsButton documentCount={1} open={false} onOpen={() => undefined} />));
    expect(container.querySelector("button")?.textContent).toContain("Documents");
    act(() => root.unmount());
  });
});
