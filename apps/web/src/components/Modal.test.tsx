// @vitest-environment happy-dom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Modal, type ModalProps } from "./Modal.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

describe("Modal", () => {
  it("renders a labelled modal panel and supports a form root", () => {
    const { container, unmount } = renderModal({
      as: "form",
      panelClassName: "custom-panel",
      backdropClassName: "custom-backdrop"
    });

    const panel = container.querySelector("form[role='dialog']");
    const title = container.querySelector("h2");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(panel?.classList.contains("custom-panel")).toBe(true);
    expect(container.querySelector(".dialog-backdrop")?.classList.contains("custom-backdrop")).toBe(true);

    unmount();
  });

  it("dismisses on Escape and a direct backdrop pointer-down", () => {
    const onClose = vi.fn();
    const { container, unmount } = renderModal({ onClose });

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => container.querySelector<HTMLElement>(".dialog-backdrop")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("does not dismiss while locked or when nested UI consumed Escape", () => {
    const lockedClose = vi.fn();
    const locked = renderModal({ onClose: lockedClose, dismissible: false });
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    act(() => locked.container.querySelector<HTMLElement>(".dialog-backdrop")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(lockedClose).not.toHaveBeenCalled();
    expect(locked.container.querySelector<HTMLButtonElement>("[aria-label='Close']")?.disabled).toBe(true);
    locked.unmount();

    const onClose = vi.fn();
    const unlocked = renderModal({ onClose });
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => document.dispatchEvent(event));
    expect(onClose).not.toHaveBeenCalled();
    unlocked.unmount();
  });

  it("owns focus, traps Tab, locks scrolling, and restores the opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const initialFocusRef = createRef<HTMLInputElement>();
    const { container, unmount } = renderModal({
      initialFocusRef,
      children: (
        <>
          <input ref={initialFocusRef} aria-label="Initial" />
          <button type="button">Last</button>
        </>
      )
    });

    const close = container.querySelector<HTMLButtonElement>("[aria-label='Close']")!;
    const initial = container.querySelector<HTMLInputElement>("[aria-label='Initial']")!;
    const last = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).at(-1)!;
    expect(document.activeElement).toBe(initial);
    expect(document.body.style.overflow).toBe("hidden");

    last.focus();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(close);

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);

    unmount();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });
});

function renderModal(overrides: Partial<ModalProps> = {}): { container: HTMLDivElement; root: Root; unmount: () => void } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const children: ReactNode = overrides.children ?? <button type="button">Action</button>;
  act(() => {
    root.render(
      <Modal open onClose={() => undefined} title="Test modal" {...overrides}>
        {children}
      </Modal>
    );
  });
  return {
    container,
    root,
    unmount: () => act(() => root.unmount())
  };
}
