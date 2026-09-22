// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MermaidDiagram, type MermaidLoader } from "./MermaidDiagram.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MermaidDiagram", () => {
  it("renders a diagram and toggles its copyable source", async () => {
    const render = vi.fn(async () => ({ svg: '<svg data-diagram="flowchart"></svg>' }));
    const loader: MermaidLoader = async () => ({ initialize: vi.fn(), render });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MermaidDiagram source={"flowchart LR\n  A --> B"} loader={loader} />);
      await settle();
    });

    expect(render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), "flowchart LR\n  A --> B");
    expect(container.querySelector("svg")?.getAttribute("data-diagram")).toBe("flowchart");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".mermaid-diagram-toolbar button")?.click();
    });
    expect(container.textContent).toContain("flowchart LR");
    expect(container.querySelector(".code-block-copy")).not.toBeNull();
    expect(container.textContent).toContain("Show diagram");
    act(() => root.unmount());
  });

  it("shows the source and supports retry when rendering fails", async () => {
    const render = vi.fn()
      .mockRejectedValueOnce(new Error("invalid syntax"))
      .mockResolvedValueOnce({ svg: '<svg data-diagram="recovered"></svg>' });
    const loader: MermaidLoader = async () => ({ initialize: vi.fn(), render });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MermaidDiagram source="not a diagram" loader={loader} />);
      await settle();
    });
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Unable to render");
    expect(container.textContent).toContain("not a diagram");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".mermaid-diagram-toolbar button")?.click();
      await settle();
    });
    expect(container.querySelector("svg")?.getAttribute("data-diagram")).toBe("recovered");
    act(() => root.unmount());
  });

  it("falls back to source when the Mermaid module cannot load", async () => {
    const loader: MermaidLoader = async () => { throw new Error("chunk failed"); };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MermaidDiagram source="sequenceDiagram" loader={loader} />);
      await settle();
    });
    expect(container.querySelector("[role='alert']")).not.toBeNull();
    expect(container.textContent).toContain("sequenceDiagram");
    act(() => root.unmount());
  });

  it("discards a stale result after the source changes", async () => {
    const first = deferred<{ svg: string }>();
    const second = deferred<{ svg: string }>();
    const render = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const loader: MermaidLoader = async () => ({ initialize: vi.fn(), render });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MermaidDiagram source={"flowchart LR\n  A --> B"} loader={loader} />);
      await settle();
    });
    await act(async () => {
      root.render(<MermaidDiagram source={"flowchart LR\n  C --> D"} loader={loader} />);
      await settle();
    });
    await act(async () => {
      second.resolve({ svg: '<svg data-diagram="new"></svg>' });
      await settle();
    });
    await act(async () => {
      first.resolve({ svg: '<svg data-diagram="stale"></svg>' });
      await settle();
    });

    expect(container.querySelector("svg")?.getAttribute("data-diagram")).toBe("new");
    act(() => root.unmount());
  });
});
