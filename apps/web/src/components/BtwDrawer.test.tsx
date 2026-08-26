// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BtwExchange } from "@muxpilot/core";
import { appendBtwDelta, BtwDrawer, parseBtwComposerInput, upsertBtwExchange } from "./BtwDrawer.js";

const copyTextMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../utils/clipboard.js", () => ({ copyText: copyTextMock }));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = "";
  copyTextMock.mockClear();
  vi.restoreAllMocks();
});

describe("BTW composer routing", () => {
  it("recognizes only the BTW command and preserves its question", () => {
    expect(parseBtwComposerInput("/btw")).toEqual({ question: null });
    expect(parseBtwComposerInput("  /BTW   where is input sent?  ")).toEqual({ question: "where is input sent?" });
    expect(parseBtwComposerInput("please /btw explain")).toBeNull();
    expect(parseBtwComposerInput("/btwice")).toBeNull();
  });

  it("upserts exchanges and appends streamed deltas", () => {
    const running = exchange({ id: "one", status: "running" });
    expect(upsertBtwExchange([], running)).toEqual([running]);
    expect(appendBtwDelta([running], { exchangeId: "one", delta: "Answer", firstTokenAt: "2026-08-26T12:00:01.000Z" })[0])
      .toMatchObject({ answer: "Answer", firstTokenAt: "2026-08-26T12:00:01.000Z" });
    expect(upsertBtwExchange([running], { ...running, status: "completed", answer: "Done" })[0])
      .toMatchObject({ status: "completed", answer: "Done" });
    expect(upsertBtwExchange([{ ...running, answer: "Streaming" }], running)[0])
      .toMatchObject({ status: "running", answer: "Streaming" });
    const completed = { ...running, status: "completed" as const, answer: "Fast answer" };
    expect(upsertBtwExchange([completed], running)[0]).toEqual(completed);
  });
});

describe("BtwDrawer", () => {
  it("submits a separate question and keeps running work cancellable", async () => {
    const ask = vi.fn(async () => true);
    const cancel = vi.fn(async () => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(
      <BtwDrawer
        open
        exchanges={[]}
        loading={false}
        error=""
        submitting={false}
        onClose={() => undefined}
        onAsk={ask}
        onCancel={cancel}
        onOpenDocument={() => undefined}
      />
    ));
    const textarea = container.querySelector("textarea")!;
    act(() => {
      setNativeTextareaValue(textarea, "What is the current branch?");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "What is the current branch?", inputType: "insertText" }));
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(ask).toHaveBeenCalledWith("What is the current branch?");

    act(() => root.render(
      <BtwDrawer
        open
        exchanges={[exchange({ status: "running" })]}
        loading={false}
        error=""
        submitting={false}
        onClose={() => undefined}
        onAsk={ask}
        onCancel={cancel}
        onOpenDocument={() => undefined}
      />
    ));
    expect(container.textContent).toContain("Checking the current session snapshot…");
    await act(async () => {
      (container.querySelector(".btw-exchange-actions button") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(cancel).toHaveBeenCalledWith("exchange-1");
    act(() => root.unmount());
  });

  it("submits with the side-question keyboard shortcut", async () => {
    const ask = vi.fn(async () => true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(
      <BtwDrawer
        open
        exchanges={[]}
        loading={false}
        error=""
        submitting={false}
        onClose={() => undefined}
        onAsk={ask}
        onCancel={async () => undefined}
        onOpenDocument={() => undefined}
      />
    ));
    const textarea = container.querySelector("textarea")!;
    act(() => {
      setNativeTextareaValue(textarea, "Can I ask this without interrupting?");
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "Can I ask this without interrupting?", inputType: "insertText" }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "Enter" }));
      await Promise.resolve();
    });

    expect(ask).toHaveBeenCalledWith("Can I ask this without interrupting?");
    act(() => root.unmount());
  });

  it("presents prior exchanges as saved independent history", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(
      <BtwDrawer
        open
        exchanges={[
          exchange({ id: "first", question: "First question", answer: "First answer" }),
          exchange({ id: "second", question: "Second question", answer: "Second answer" })
        ]}
        loading={false}
        error=""
        submitting={false}
        onClose={() => undefined}
        onAsk={async () => true}
        onCancel={async () => undefined}
        onOpenDocument={() => undefined}
      />
    ));

    expect(container.textContent).toContain("Each request is independent.");
    expect(container.textContent).toContain("fresh snapshot of the main session");
    expect(container.textContent).toContain("Document changes are isolated until muxpilot can hand them off safely.");
    expect(container.textContent).toContain("History");
    expect(container.textContent).toContain("Ask a question or request a document update");
    expect(container.querySelector(".btw-exchange-list")?.getAttribute("aria-label")).toBe("Saved independent question history");
    expect(container.querySelectorAll(".btw-exchange")).toHaveLength(2);
    expect(container.querySelectorAll(".btw-answer-heading")).toHaveLength(2);
    expect(container.querySelectorAll(".btw-answer-heading")[0]?.textContent).toContain("Answer");
    expect(container.querySelector(".btw-answer-heading svg")).toBeNull();
    act(() => root.unmount());
  });

  it("copies exact question and answer text from their context menus", async () => {
    const close = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const saved = exchange({
      question: "Which branch is active?",
      answer: "**main** is active."
    });

    act(() => root.render(
      <BtwDrawer
        open
        exchanges={[saved]}
        loading={false}
        error=""
        submitting={false}
        onClose={close}
        onAsk={async () => true}
        onCancel={async () => undefined}
        onOpenDocument={() => undefined}
      />
    ));

    expect(container.querySelector(".btw-exchange-actions")).toBeNull();
    expect(container.textContent).not.toContain("Copy answer");
    const question = container.querySelector(".btw-question")!;
    const answer = container.querySelector(".btw-answer")!;
    expect(question.hasAttribute("data-context-menu-trigger")).toBe(true);
    expect(answer.hasAttribute("data-context-menu-trigger")).toBe(true);

    act(() => question.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32
    })));
    expect(container.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("BTW question actions");
    expect(container.querySelector('[role="menuitem"]')?.textContent).toContain("Copy question");
    await act(async () => {
      (container.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(copyTextMock).toHaveBeenLastCalledWith(saved.question);

    act(() => answer.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 48
    })));
    expect(container.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("BTW answer actions");
    expect(container.querySelector('[role="menuitem"]')?.textContent).toContain("Copy answer");
    await act(async () => {
      (container.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(copyTextMock).toHaveBeenLastCalledWith(saved.answer);

    act(() => question.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32
    })));
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
    expect(close).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("shows document handoff progress and opens applied files", () => {
    const openDocument = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(
      <BtwDrawer
        open
        exchanges={[exchange({
          documentOperation: { phase: "applied", created: ["plan.md"], updated: ["INDEX.md"], retryCount: 0 }
        })]}
        loading={false}
        error=""
        submitting={false}
        onClose={() => undefined}
        onAsk={async () => true}
        onCancel={async () => undefined}
        onOpenDocument={openDocument}
      />
    ));

    expect(container.textContent).toContain("Document changes applied");
    expect(container.textContent).toContain("plan.mdCreated");
    act(() => (container.querySelector(".btw-document-links button") as HTMLButtonElement).click());
    expect(openDocument).toHaveBeenCalledWith("plan.md");
    act(() => root.unmount());
  });
});

function exchange(overrides: Partial<BtwExchange> = {}): BtwExchange {
  return {
    id: "exchange-1",
    sessionId: "session-1",
    question: "Question?",
    answer: "",
    status: "completed",
    error: null,
    createdAt: "2026-08-26T12:00:00.000Z",
    firstTokenAt: null,
    completedAt: "2026-08-26T12:00:01.000Z",
    ...overrides
  };
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Expected the native textarea value setter");
  setter.call(textarea, value);
}
