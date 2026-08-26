// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { DocumentsModal } from "./SessionView.js";

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
    vi.spyOn(api, "sessionDocuments").mockResolvedValue({
      sampledAt: "2026-08-25T00:00:00.000Z",
      documents: [
        { name: "tasks.md", sizeBytes: 8, updatedAt: "2026-08-25T00:00:00.000Z" },
        { name: "INDEX.md", sizeBytes: 15, updatedAt: "2026-08-25T00:00:00.000Z" }
      ]
    });
    const read = vi.spyOn(api, "sessionDocument").mockResolvedValue({
      document: { name: "INDEX.md", content: "# Durable plan", sizeBytes: 14, updatedAt: "2026-08-25T00:00:00.000Z" }
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(read).toHaveBeenCalledWith("session-1", "INDEX.md");
    expect(container.querySelector("h1")?.textContent).toBe("Durable plan");
    expect(container.querySelector("button[data-active='true'] strong")?.textContent).toBe("INDEX.md");
    act(() => root.unmount());
  });

  it("shows an empty state", async () => {
    vi.spyOn(api, "sessionDocuments").mockResolvedValue({ documents: [], sampledAt: "2026-08-25T00:00:00.000Z" });
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<DocumentsModal open sessionId="session-1" onClose={() => undefined} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("This session has no documents yet.");
    act(() => root.unmount());
  });
});
