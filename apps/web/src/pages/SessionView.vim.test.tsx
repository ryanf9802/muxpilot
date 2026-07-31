// @vitest-environment happy-dom

import { getCM } from "@replit/codemirror-vim";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetVimToNormalMode, runVimFocusCommand, SkillTextArea } from "./SessionView.js";

const skills = [
  { name: "first-skill", description: "First skill", source: "user" as const }
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
});

describe("Vim composer lifecycle", () => {
  it("preserves the editor, focus, caret, and insert mode across passive updates", () => {
    renderComposer({ placeholder: "Queue message", skills });
    const editor = requireEditor();
    const view = requireView(editor);

    act(() => {
      view.dispatch({ selection: { anchor: 3 } });
      runVimFocusCommand(view, "insert");
    });

    expect(view.hasFocus).toBe(true);
    expect(getCM(view)?.state.vim?.insertMode).toBe(true);

    renderComposer({
      placeholder: "Message Codex",
      skills: [...skills, { name: "second-skill", description: "Second skill", source: "user" as const }]
    });

    expect(requireEditor()).toBe(editor);
    expect(requireView(editor)).toBe(view);
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.head).toBe(3);
    expect(view.state.doc.toString()).toBe("draft");
    expect(getCM(view)?.state.vim?.insertMode).toBe(true);
  });

  it("retains the normal-mode reset used by genuine blur handling", () => {
    renderComposer({ placeholder: "Message Codex", skills });
    const view = requireView(requireEditor());

    act(() => {
      runVimFocusCommand(view, "insert");
      view.contentDOM.blur();
      resetVimToNormalMode(view);
    });

    expect(view.hasFocus).toBe(false);
    expect(getCM(view)?.state.vim?.insertMode).toBe(false);
  });
});

function renderComposer({
  placeholder,
  skills: nextSkills
}: {
  placeholder: string;
  skills: typeof skills;
}) {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      <SkillTextArea
        value="draft"
        onChange={vi.fn()}
        vimEnabled
        skills={nextSkills}
        placeholder={placeholder}
      />
    );
  });
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
