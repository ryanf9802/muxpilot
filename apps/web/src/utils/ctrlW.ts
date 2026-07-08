export interface CtrlWKeyboardEvent {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  preventDefault: () => void;
  target: EventTarget | null;
}

export interface TextDeletionRange {
  start: number;
  end: number;
}

export function shouldHandleCtrlW(event: Pick<CtrlWKeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">): boolean {
  return event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "w";
}

export function previousWordDeletionRange(value: string, selectionStart: number, selectionEnd: number): TextDeletionRange {
  const start = clampOffset(Math.min(selectionStart, selectionEnd), value.length);
  const end = clampOffset(Math.max(selectionStart, selectionEnd), value.length);
  if (start !== end) return { start, end };

  let deleteStart = start;
  while (deleteStart > 0 && /\s/.test(value[deleteStart - 1] ?? "")) deleteStart -= 1;
  while (deleteStart > 0 && !/\s/.test(value[deleteStart - 1] ?? "")) deleteStart -= 1;
  return { start: deleteStart, end };
}

export function handleCtrlWKeyDown(event: CtrlWKeyboardEvent): boolean {
  if (!shouldHandleCtrlW(event)) return false;

  event.preventDefault();
  if (isEditableValueElement(event.target)) {
    deletePreviousWordInValueElement(event.target);
    return true;
  }
  if (isEditableTextElement(event.target)) {
    deletePreviousWordInTextElement(event.target);
    return true;
  }
  return true;
}

export function installCtrlWGuard(target: Document = document): () => void {
  const listener = (event: KeyboardEvent) => {
    handleCtrlWKeyDown(event);
  };
  target.addEventListener("keydown", listener, { capture: true });
  return () => target.removeEventListener("keydown", listener, { capture: true });
}

function deletePreviousWordInValueElement(element: HTMLInputElement | HTMLTextAreaElement): void {
  const selectionStart = element.selectionStart ?? element.value.length;
  const selectionEnd = element.selectionEnd ?? selectionStart;
  const range = previousWordDeletionRange(element.value, selectionStart, selectionEnd);
  const nextValue = `${element.value.slice(0, range.start)}${element.value.slice(range.end)}`;

  setElementValue(element, nextValue);
  try {
    element.setSelectionRange(range.start, range.start);
  } catch {
    // Some input types do not support text selection.
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function setElementValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const isTextarea = typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement;
  const prototype = isTextarea
    ? HTMLTextAreaElement.prototype
    : typeof HTMLInputElement !== "undefined"
      ? HTMLInputElement.prototype
      : null;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
  if (setter) {
    setter.call(element, value);
    return;
  }
  element.value = value;
}

function deletePreviousWordInTextElement(element: HTMLElement): void {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;

  if (!range.collapsed) {
    range.deleteContents();
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  const text = element.textContent ?? "";
  const caret = textOffsetForRange(element, range);
  const deletion = previousWordDeletionRange(text, caret, caret);
  if (deletion.start === deletion.end) return;

  const deleteRange = element.ownerDocument.createRange();
  const startPosition = nodePositionForTextOffset(element, deletion.start);
  const endPosition = nodePositionForTextOffset(element, deletion.end);
  deleteRange.setStart(startPosition.node, startPosition.offset);
  deleteRange.setEnd(endPosition.node, endPosition.offset);
  deleteRange.deleteContents();

  selection.removeAllRanges();
  const nextCaret = element.ownerDocument.createRange();
  const caretPosition = nodePositionForTextOffset(element, deletion.start);
  nextCaret.setStart(caretPosition.node, caretPosition.offset);
  nextCaret.collapse(true);
  selection.addRange(nextCaret);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function isEditableValueElement(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  const hasInput = typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement;
  const hasTextarea = typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement;
  if (!hasInput && !hasTextarea) return false;
  return !target.disabled && !target.readOnly;
}

function isEditableTextElement(target: EventTarget | null): target is HTMLElement {
  return typeof HTMLElement !== "undefined" && target instanceof HTMLElement && target.isContentEditable;
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return length;
  return Math.max(0, Math.min(value, length));
}

function textOffsetForRange(root: Node, range: Range): number {
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return prefix.toString().length;
}

function nodePositionForTextOffset(root: Node, offset: number): { node: Node; offset: number } {
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT) ?? null;
  let remaining = offset;
  let lastTextNode: Text | null = null;

  while (walker) {
    const next = walker.nextNode() as Text | null;
    if (!next) break;
    lastTextNode = next;
    if (remaining <= next.data.length) return { node: next, offset: remaining };
    remaining -= next.data.length;
  }

  if (lastTextNode) return { node: lastTextNode, offset: lastTextNode.data.length };
  return { node: root, offset: root.childNodes.length };
}
