// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CodeBlock, codeBlockText, selectCodeBlockContents } from "./CodeBlock.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe("CodeBlock", () => {
  it("renders selectable code and an accessible bottom copy action", () => {
    const rendered = renderCodeBlock("const answer = 42;\n", "language-ts");

    expect(rendered.container.querySelector("code")?.textContent).toBe("const answer = 42;\n");
    expect(rendered.container.querySelector("code")?.classList.contains("language-ts")).toBe(true);
    expect(rendered.container.querySelector<HTMLButtonElement>(".code-block-copy")?.getAttribute("aria-label")).toBe("Copy code block");

    rendered.unmount();
  });

  it("copies the exact code from both the button and context menu", async () => {
    const writeText = installClipboard();
    const rendered = renderCodeBlock("first line\n  second line\n");

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(".code-block-copy")?.click();
    });
    expect(writeText).toHaveBeenLastCalledWith("first line\n  second line\n");
    expect(rendered.container.querySelector<HTMLButtonElement>(".code-block-copy")?.textContent).toContain("Copied");

    act(() => {
      rendered.container.querySelector("code")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 36 })
      );
    });
    const menuItem = rendered.container.querySelector<HTMLButtonElement>("[role='menuitem']");
    expect(menuItem?.textContent).toContain("Copy code block");

    await act(async () => {
      menuItem?.click();
    });
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("first line\n  second line\n");
    expect(rendered.container.querySelector("[role='menu']")).toBeNull();

    rendered.unmount();
  });

  it("selects only the full code contents on triple-click", () => {
    const rendered = renderCodeBlock("alpha\nbeta\n");
    const code = rendered.container.querySelector<HTMLElement>("code")!;

    act(() => {
      code.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 3 }));
    });

    expect(window.getSelection()?.toString()).toBe("alpha\nbeta\n");
    rendered.unmount();
  });

  it("keeps context-menu and touch pointer events inside the code block", () => {
    const onContextMenu = vi.fn();
    const onPointerDown = vi.fn();
    const rendered = renderCodeBlock("code", undefined, { onContextMenu, onPointerDown });
    const code = rendered.container.querySelector("code")!;
    const touchContextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    act(() => {
      code.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, pointerType: "touch" }));
      code.dispatchEvent(touchContextMenu);
    });

    expect(onContextMenu).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(touchContextMenu.defaultPrevented).toBe(false);
    expect(rendered.container.querySelector("[role='menu']")).toBeNull();
    rendered.unmount();
  });
});

describe("code block helpers", () => {
  it("extracts nested rendered code text", () => {
    expect(codeBlockText(<code className="language-ts">{"const x = 1;\n"}</code>)).toBe("const x = 1;\n");
  });

  it("returns false when selection is unavailable", () => {
    const code = document.createElement("code");
    const selection = code.ownerDocument.defaultView?.getSelection;
    if (code.ownerDocument.defaultView) {
      Object.defineProperty(code.ownerDocument.defaultView, "getSelection", { configurable: true, value: () => null });
    }
    expect(selectCodeBlockContents(code)).toBe(false);
    if (code.ownerDocument.defaultView) {
      Object.defineProperty(code.ownerDocument.defaultView, "getSelection", { configurable: true, value: selection });
    }
  });
});

function renderCodeBlock(
  text: string,
  codeClassName?: string,
  parentHandlers: { onContextMenu?: () => void; onPointerDown?: () => void } = {}
): { container: HTMLDivElement; root: Root; unmount: () => void } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <div {...parentHandlers}>
        <CodeBlock text={text} codeClassName={codeClassName} />
      </div>
    );
  });
  return {
    container,
    root,
    unmount: () => act(() => root.unmount())
  };
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText }
  });
  return writeText;
}
