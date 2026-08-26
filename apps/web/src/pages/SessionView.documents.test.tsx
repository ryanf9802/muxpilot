// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { DocumentsButton, DocumentsModal } from "./SessionView.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("DocumentsModal", () => {
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
    expect(documentLink?.target).toBe("");
    expect(externalLink?.target).toBe("_blank");
    expect(externalLink?.rel).toBe("noopener noreferrer");

    await act(async () => {
      documentLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(read).toHaveBeenLastCalledWith("session-1", "plan.md");
    expect(container.querySelector(".documents-viewer")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".documents-viewer")?.textContent).toBe("Loading plan.md…");
    expect(container.querySelector("button[data-active='true']")?.getAttribute("aria-current")).toBe("page");

    await act(async () => {
      resolvePlan({ document: { name: "plan.md", content: "## Current plan", sizeBytes: 15, updatedAt: documents[1]!.updatedAt } });
      await planResponse;
      await Promise.resolve();
    });

    expect(container.querySelector(".documents-viewer")?.hasAttribute("aria-busy")).toBe(false);
    expect(container.querySelector(".documents-viewer h2")?.textContent).toBe("Current plan");
    expect(container.querySelector("button[data-active='true'] strong")?.textContent).toBe("plan.md");
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
