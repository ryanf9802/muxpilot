import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCtrlJKeyDown, handleCtrlWKeyDown, previousWordDeletionRange, shouldHandleCtrlJ, shouldHandleCtrlW } from "./ctrlW.js";

class FakeInputElement extends EventTarget {
  disabled = false;
  readOnly = false;
  selectionEnd: number | null;
  selectionStart: number | null;
  value: string;

  constructor(value: string, selectionStart = value.length, selectionEnd = selectionStart) {
    super();
    this.value = value;
    this.selectionStart = selectionStart;
    this.selectionEnd = selectionEnd;
  }

  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class FakeTextAreaElement extends FakeInputElement {}

class FakeCodeMirrorElement extends EventTarget {
  isContentEditable = false;

  closest(selector: string) {
    return selector === ".cm-editor" ? this : null;
  }
}

class ReactTrackedInputElement extends EventTarget {
  disabled = false;
  readOnly = false;
  selectionEnd: number | null;
  selectionStart: number | null;
  trackedValue: string | null = null;
  private currentValue: string;

  constructor(value: string, selectionStart = value.length, selectionEnd = selectionStart) {
    super();
    this.currentValue = value;
    this.selectionStart = selectionStart;
    this.selectionEnd = selectionEnd;
    Object.defineProperty(this, "value", {
      configurable: true,
      get: () => this.currentValue,
      set: (next: string) => {
        this.trackedValue = next;
        this.currentValue = next;
      }
    });
  }

  get value() {
    return this.currentValue;
  }

  set value(next: string) {
    this.currentValue = next;
  }

  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldHandleCtrlW", () => {
  it("matches plain Ctrl+W only", () => {
    expect(shouldHandleCtrlW({ ctrlKey: true, key: "w", altKey: false, metaKey: false })).toBe(true);
    expect(shouldHandleCtrlW({ ctrlKey: true, key: "W", altKey: false, metaKey: false })).toBe(true);
    expect(shouldHandleCtrlW({ ctrlKey: true, key: "Enter", altKey: false, metaKey: false })).toBe(false);
    expect(shouldHandleCtrlW({ ctrlKey: true, key: "w", altKey: true, metaKey: false })).toBe(false);
    expect(shouldHandleCtrlW({ ctrlKey: true, key: "w", altKey: false, metaKey: true })).toBe(false);
  });
});

describe("shouldHandleCtrlJ", () => {
  it("matches plain Ctrl+J only", () => {
    expect(shouldHandleCtrlJ({ ctrlKey: true, key: "j", altKey: false, metaKey: false })).toBe(true);
    expect(shouldHandleCtrlJ({ ctrlKey: true, key: "J", altKey: false, metaKey: false })).toBe(true);
    expect(shouldHandleCtrlJ({ ctrlKey: true, key: "Enter", altKey: false, metaKey: false })).toBe(false);
    expect(shouldHandleCtrlJ({ ctrlKey: true, key: "j", altKey: true, metaKey: false })).toBe(false);
    expect(shouldHandleCtrlJ({ ctrlKey: true, key: "j", altKey: false, metaKey: true })).toBe(false);
  });
});

describe("previousWordDeletionRange", () => {
  it("selects the previous word at the caret", () => {
    expect(previousWordDeletionRange("alpha beta", 10, 10)).toEqual({ start: 6, end: 10 });
  });

  it("selects trailing whitespace plus the previous word", () => {
    expect(previousWordDeletionRange("alpha beta   ", 13, 13)).toEqual({ start: 6, end: 13 });
  });

  it("uses the selected range when text is selected", () => {
    expect(previousWordDeletionRange("alpha beta", 2, 8)).toEqual({ start: 2, end: 8 });
  });
});

describe("handleCtrlWKeyDown", () => {
  it("deletes the previous word in editable input-like targets", () => {
    vi.stubGlobal("HTMLInputElement", FakeInputElement);
    const input = new FakeInputElement("alpha beta", 10);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    const preventDefault = vi.fn();

    const handled = handleCtrlWKeyDown({
      ctrlKey: true,
      key: "w",
      altKey: false,
      metaKey: false,
      preventDefault,
      target: input
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input.value).toBe("alpha ");
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(6);
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("deletes selected text in editable input-like targets", () => {
    vi.stubGlobal("HTMLInputElement", FakeInputElement);
    const input = new FakeInputElement("alpha beta", 2, 8);

    handleCtrlWKeyDown({
      ctrlKey: true,
      key: "w",
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      target: input
    });

    expect(input.value).toBe("alta");
    expect(input.selectionStart).toBe(2);
  });

  it("uses the native prototype setter so React controlled inputs observe the input event", () => {
    vi.stubGlobal("HTMLInputElement", ReactTrackedInputElement);
    const input = new ReactTrackedInputElement("alpha beta", 10);

    handleCtrlWKeyDown({
      ctrlKey: true,
      key: "w",
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      target: input
    });

    expect(input.value).toBe("alpha ");
    expect(input.trackedValue).toBeNull();
  });

  it("swallows Ctrl+W without editing read-only input-like targets", () => {
    vi.stubGlobal("HTMLInputElement", FakeInputElement);
    const input = new FakeInputElement("alpha beta", 10);
    input.readOnly = true;
    const preventDefault = vi.fn();

    const handled = handleCtrlWKeyDown({
      ctrlKey: true,
      key: "w",
      altKey: false,
      metaKey: false,
      preventDefault,
      target: input
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input.value).toBe("alpha beta");
  });

  it("ignores other shortcuts", () => {
    const preventDefault = vi.fn();

    const handled = handleCtrlWKeyDown({
      ctrlKey: true,
      key: "Enter",
      altKey: false,
      metaKey: false,
      preventDefault,
      target: null
    });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("handleCtrlJKeyDown", () => {
  it("inserts a newline in editable textarea targets", () => {
    vi.stubGlobal("HTMLTextAreaElement", FakeTextAreaElement);
    const textarea = new FakeTextAreaElement("alpha beta", 5);
    const onInput = vi.fn();
    textarea.addEventListener("input", onInput);
    const preventDefault = vi.fn();

    const handled = handleCtrlJKeyDown({
      ctrlKey: true,
      key: "j",
      altKey: false,
      metaKey: false,
      preventDefault,
      target: textarea
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("alpha\n beta");
    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("replaces selected textarea text with a newline", () => {
    vi.stubGlobal("HTMLTextAreaElement", FakeTextAreaElement);
    const textarea = new FakeTextAreaElement("alpha beta", 5, 6);

    handleCtrlJKeyDown({
      ctrlKey: true,
      key: "j",
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      target: textarea
    });

    expect(textarea.value).toBe("alpha\nbeta");
    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);
  });

  it("swallows Ctrl+J without editing single-line input targets", () => {
    vi.stubGlobal("HTMLInputElement", FakeInputElement);
    const input = new FakeInputElement("alpha beta", 5);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    const preventDefault = vi.fn();

    const handled = handleCtrlJKeyDown({
      ctrlKey: true,
      key: "j",
      altKey: false,
      metaKey: false,
      preventDefault,
      target: input
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(input.value).toBe("alpha beta");
    expect(onInput).not.toHaveBeenCalled();
  });

  it("swallows Ctrl+J without editing read-only textarea targets", () => {
    vi.stubGlobal("HTMLTextAreaElement", FakeTextAreaElement);
    const textarea = new FakeTextAreaElement("alpha beta", 5);
    textarea.readOnly = true;
    const preventDefault = vi.fn();

    const handled = handleCtrlJKeyDown({
      ctrlKey: true,
      key: "j",
      altKey: false,
      metaKey: false,
      preventDefault,
      target: textarea
    });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("alpha beta");
  });

  it("lets CodeMirror targets handle Ctrl+J locally", () => {
    vi.stubGlobal("HTMLElement", FakeCodeMirrorElement);
    const target = new FakeCodeMirrorElement();
    const preventDefault = vi.fn();

    const handled = handleCtrlJKeyDown({
      ctrlKey: true,
      key: "j",
      altKey: false,
      metaKey: false,
      preventDefault,
      target
    });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("ignores other shortcuts", () => {
    const preventDefault = vi.fn();

    const handled = handleCtrlJKeyDown({
      ctrlKey: true,
      key: "Enter",
      altKey: false,
      metaKey: false,
      preventDefault,
      target: null
    });

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
