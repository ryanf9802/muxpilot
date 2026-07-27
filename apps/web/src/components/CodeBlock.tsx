import { Check, Copy } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { copyText } from "../utils/clipboard.js";
import { ContextMenu, ContextMenuItem, useDismissableContextMenu, type ContextMenuPosition } from "./ContextMenu.js";

const COPIED_FEEDBACK_MS = 1600;

export interface CodeBlockProps {
  text: string;
  codeClassName?: string;
}

export function CodeBlock({ text, codeClassName }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTouchPointerRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [menuPosition, setMenuPosition] = useState<ContextMenuPosition | null>(null);

  useDismissableContextMenu(Boolean(menuPosition), menuRef, () => setMenuPosition(null));

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  async function copyCode() {
    setMenuPosition(null);
    try {
      await copyText(text);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, COPIED_FEEDBACK_MS);
    } catch (error) {
      console.error(error);
      setCopied(false);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch") activeTouchPointerRef.current = event.pointerId;
    event.stopPropagation();
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (activeTouchPointerRef.current === event.pointerId) activeTouchPointerRef.current = null;
    event.stopPropagation();
  }

  function openContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    const pointerType = "pointerType" in event.nativeEvent
      ? (event.nativeEvent as PointerEvent).pointerType
      : null;
    if (pointerType === "touch" || activeTouchPointerRef.current !== null) return;
    event.preventDefault();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  }

  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.detail !== 3 || !codeRef.current) return;
    event.preventDefault();
    selectCodeBlockContents(codeRef.current);
  }

  return (
    <div
      className="code-block"
      onClick={handleClick}
      onContextMenu={openContextMenu}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerLeave={handlePointerEnd}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={handlePointerEnd}
    >
      <pre>
        <code ref={codeRef} className={codeClassName}>
          {text}
        </code>
      </pre>
      <button
        type="button"
        className="code-block-copy"
        aria-label={copied ? "Code block copied" : "Copy code block"}
        title={copied ? "Copied" : "Copy code block"}
        onClick={(event) => {
          event.stopPropagation();
          void copyCode();
        }}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
      {menuPosition ? (
        <ContextMenu ref={menuRef} position={menuPosition} label="Code block actions" className="code-block-menu">
          <ContextMenuItem icon={<Copy size={16} />} onClick={() => void copyCode()}>
            Copy code block
          </ContextMenuItem>
        </ContextMenu>
      ) : null}
    </div>
  );
}

export function codeBlockText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(codeBlockText).join("");
  if (!children || typeof children !== "object" || !("props" in children)) return "";
  return codeBlockText((children.props as { children?: ReactNode }).children);
}

export function selectCodeBlockContents(code: HTMLElement): boolean {
  const selection = code.ownerDocument.defaultView?.getSelection();
  if (!selection) return false;
  const range = code.ownerDocument.createRange();
  range.selectNodeContents(code);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
