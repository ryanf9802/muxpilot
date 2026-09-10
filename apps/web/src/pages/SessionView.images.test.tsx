// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ImagePreviewModal, MixedUserContent, copyMessageActionLabel } from "./SessionView.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("session image messages", () => {
  it("opens and targets only the image control", () => {
    const onOpenImage = vi.fn();
    const onOpenImageMenu = vi.fn();
    const parentMenu = vi.fn();
    render(
      <div onContextMenu={parentMenu}>
        <MixedUserContent
          sessionId="session-1"
          text="before after"
          content={[
            { type: "text", text: "before " },
            { type: "image", id: "image.png", mimeType: "image/png" },
            { type: "text", text: " after" }
          ]}
          copyTarget={{ label: "Copy user message", text: "before after" }}
          onOpenImage={onOpenImage}
          onOpenImageMenu={onOpenImageMenu}
        />
      </div>
    );
    const mixed = container!.querySelector<HTMLElement>(".user-mixed-content")!;
    const button = container!.querySelector<HTMLButtonElement>(".user-message-image")!;

    act(() => mixed.click());
    expect(onOpenImage).not.toHaveBeenCalled();

    act(() => button.click());
    expect(onOpenImage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", id: "image.png" }));

    act(() => button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 24 })));
    expect(onOpenImageMenu).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", id: "image.png" }),
      { label: "Copy user message", text: "before after" },
      12,
      24
    );
    expect(parentMenu).not.toHaveBeenCalled();
  });

  it("renders the image preview in the app modal", () => {
    const onClose = vi.fn();
    render(<ImagePreviewModal image={{ type: "image", sessionId: "session-1", id: "image.png", mimeType: "image/png" }} onClose={onClose} />);
    expect(container!.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container!.querySelector<HTMLImageElement>(".image-preview-modal img")?.src).toContain("/api/sessions/session-1/images/image.png");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses explicit copy labels for each message role", () => {
    expect(copyMessageActionLabel({ role: "user" })).toBe("Copy user message");
    expect(copyMessageActionLabel({ role: "assistant" })).toBe("Copy assistant message");
    expect(copyMessageActionLabel({ role: "system" })).toBe("Copy system message");
    expect(copyMessageActionLabel({ role: "tool" })).toBe("Copy tool output");
  });
});

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}
