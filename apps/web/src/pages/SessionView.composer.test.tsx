// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CodexSkill } from "@muxpilot/core";
import { SkillTextArea } from "./SessionView.js";

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
});

describe("native composer lifecycle", () => {
  it("keeps the native textarea, focus, and caret across passive updates", () => {
    renderComposer({ placeholder: "Queue message", skills });
    const textarea = requireTextarea();

    act(() => {
      textarea.focus();
      textarea.setSelectionRange(3, 3);
    });

    renderComposer({
      placeholder: "Message Codex",
      skills: [...skills, { name: "second-skill", description: "Second skill", source: "user" }]
    });

    expect(requireTextarea()).toBe(textarea);
    expect(container?.querySelector(".cm-editor")).toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(3);
    expect(textarea.autocomplete).toBe("off");
    expect(textarea.getAttribute("autocapitalize")).toBe("sentences");
    expect(textarea.inputMode).toBe("text");
  });

  it("forwards composed input and does not submit from a composing key event", () => {
    const onChange = vi.fn();
    const onSubmitShortcut = vi.fn();
    renderControlledComposer({ onChange, onSubmitShortcut });
    const textarea = requireTextarea();

    act(() => {
      textarea.focus();
      setNativeTextareaValue(textarea, "ㅎ");
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "ㅎ",
        inputType: "insertCompositionText",
        isComposing: true
      }));
    });
    expect(requireTextarea()).toBe(textarea);
    expect(textarea.value).toBe("ㅎ");

    act(() => {
      setNativeTextareaValue(textarea, "한");
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "한",
        inputType: "insertCompositionText",
        isComposing: true
      }));
    });

    expect(onChange).toHaveBeenLastCalledWith("한");
    expect(requireTextarea()).toBe(textarea);
    expect(textarea.value).toBe("한");
    expect(document.activeElement).toBe(textarea);

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        isComposing: true,
        key: "Enter"
      }));
    });
    expect(onSubmitShortcut).not.toHaveBeenCalled();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "Enter"
      }));
    });
    expect(onSubmitShortcut).toHaveBeenCalledOnce();
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

function renderControlledComposer({
  onChange,
  onSubmitShortcut
}: {
  onChange: (value: string) => void;
  onSubmitShortcut: () => void;
}): void {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(<ControlledComposer onChange={onChange} onSubmitShortcut={onSubmitShortcut} />);
  });
}

function ControlledComposer({
  onChange,
  onSubmitShortcut
}: {
  onChange: (value: string) => void;
  onSubmitShortcut: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <SkillTextArea
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
      onSubmitShortcut={onSubmitShortcut}
      skills={skills}
      placeholder="Message Codex"
    />
  );
}

function requireTextarea(): HTMLTextAreaElement {
  const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("Expected a native textarea");
  return textarea;
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Expected the native textarea value setter");
  setter.call(textarea, value);
}
