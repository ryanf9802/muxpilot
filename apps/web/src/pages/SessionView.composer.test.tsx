// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodexSkill } from "@muxpilot/core";
import { ComposerSubmissionAlert, composerContent, composerSubmissionError, SkillTextArea } from "./SessionView.js";
import { api } from "../api/client.js";

const skills: CodexSkill[] = [
  { name: "first-skill", description: "First skill", source: "user" }
];

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
  vi.restoreAllMocks();
});

describe("composer lifecycle", () => {
  it("keeps the editor, focus, and caret across passive updates", () => {
    renderComposer({ placeholder: "Queue message", skills });
    const editor = requireEditor();
    const view = requireView(editor);

    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 3 } });
    });

    renderComposer({
      placeholder: "Message Codex",
      skills: [...skills, { name: "second-skill", description: "Second skill", source: "user" }]
    });

    expect(requireEditor()).toBe(editor);
    expect(requireView(editor)).toBe(view);
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.head).toBe(3);
    expect(view.contentDOM.getAttribute("autocomplete")).toBe("off");
    expect(getCM(view)).toBeNull();
  });

  it("forwards edits and submits from Ctrl-Enter", () => {
    const onChange = vi.fn();
    const onSubmitShortcut = vi.fn();
    renderComposer({ placeholder: "Message Codex", skills, value: "", onChange, onSubmitShortcut });
    const view = requireView(requireEditor());

    act(() => {
      view.dispatch({ changes: { from: 0, insert: "hello" } });
    });
    expect(onChange).toHaveBeenLastCalledWith("hello");

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "Enter"
      }));
    });
    expect(onSubmitShortcut).toHaveBeenCalledOnce();
  });

  it("preserves the order of text and inline images", () => {
    expect(composerContent("before [[muxpilot-image:abc.png:image/png]] after")).toEqual({
      text: "before  after",
      content: [
        { type: "text", text: "before " },
        { type: "image", id: "abc.png", mimeType: "image/png" },
        { type: "text", text: " after" }
      ]
    });
  });

  it("preserves the server explanation for rejected composer submissions", () => {
    const explanation = composerSubmissionError(new Error("Waiting for active sessions to reach a safe boundary."));
    expect(explanation).toBe("Waiting for active sessions to reach a safe boundary.");
    expect(composerSubmissionError("Connection closed")).toBe("Connection closed");

    renderNode(<ComposerSubmissionAlert error={explanation} />);
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(explanation);
  });

  it("inserts a pasted image at the caret and replaces its upload marker in place", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(api, "uploadImage").mockResolvedValue({ image: { type: "image", id: "stored.png", mimeType: "image/png" } });
    const onChange = vi.fn();
    renderComposer({ placeholder: "Message Codex", skills, value: "before after", onChange });
    const view = requireView(requireEditor());
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: 7 } });
    });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [new File([new Uint8Array([137, 80, 78, 71])], "paste.png", { type: "image/png" })] }
    });

    await act(async () => {
      view.contentDOM.dispatchEvent(paste);
      await Promise.resolve();
    });

    expect(view.state.doc.toString()).toBe("before [[muxpilot-image:stored.png:image/png]]after");
    expect(onChange).toHaveBeenLastCalledWith("before [[muxpilot-image:stored.png:image/png]]after");
  });
});

function renderComposer({
  placeholder,
  skills: nextSkills,
  value = "draft",
  onChange = vi.fn(),
  onSubmitShortcut = vi.fn()
}: {
  placeholder: string;
  skills: CodexSkill[];
  value?: string;
  onChange?: (value: string) => void;
  onSubmitShortcut?: () => void;
}) {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      <SkillTextArea
        value={value}
        onChange={onChange}
        onSubmitShortcut={onSubmitShortcut}
        skills={nextSkills}
        placeholder={placeholder}
      />
    );
  });
}

function renderNode(node: ReactNode) {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

function requireEditor(): HTMLElement {
  const editor = container?.querySelector<HTMLElement>(".cm-editor");
  if (!editor) throw new Error("Expected a CodeMirror editor");
  return editor;
}

function requireView(editor: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error("Expected an EditorView");
  return view;
}
