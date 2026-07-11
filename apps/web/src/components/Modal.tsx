import {
  useEffect,
  useId,
  useRef,
  type FormEventHandler,
  type ReactNode,
  type RefObject
} from "react";
import { X } from "lucide-react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export interface ModalProps {
  open: boolean;
  onClose: () => void | Promise<void>;
  title: ReactNode;
  children: ReactNode;
  dismissible?: boolean;
  panelClassName?: string;
  backdropClassName?: string;
  closeLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  as?: "section" | "form";
  onSubmit?: FormEventHandler<HTMLFormElement>;
  loading?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  dismissible = true,
  panelClassName = "",
  backdropClassName = "",
  closeLabel = "Close",
  initialFocusRef,
  as = "section",
  onSubmit,
  loading = false
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const initialFocus = initialFocusRef?.current ?? focusableElements(panel)[0] ?? panel;
      initialFocus.focus();
    }

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || !panelRef.current) return;
      const focusable = focusableElements(panelRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open || !dismissible) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      void onCloseRef.current();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [dismissible, open]);

  if (!open) return null;

  const panelClasses = `modal-panel${panelClassName ? ` ${panelClassName}` : ""}`;
  const backdropClasses = `dialog-backdrop${backdropClassName ? ` ${backdropClassName}` : ""}`;
  const panelContent = (
    <>
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" onClick={() => void onClose()} aria-label={closeLabel} disabled={!dismissible}>
          <X size={18} />
        </button>
      </div>
      {children}
    </>
  );

  return (
    <div
      className={backdropClasses}
      role="presentation"
      onPointerDown={(event) => {
        if (dismissible && event.currentTarget === event.target) void onClose();
      }}
    >
      {as === "form" ? (
        <form
          ref={(element) => { panelRef.current = element; }}
          className={panelClasses}
          onSubmit={onSubmit}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={loading || undefined}
          tabIndex={-1}
        >
          {panelContent}
        </form>
      ) : (
        <section
          ref={(element) => { panelRef.current = element; }}
          className={panelClasses}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={loading || undefined}
          tabIndex={-1}
        >
          {panelContent}
        </section>
      )}
    </div>
  );
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    return element.getAttribute("aria-hidden") !== "true" && !element.closest("[hidden]");
  });
}
