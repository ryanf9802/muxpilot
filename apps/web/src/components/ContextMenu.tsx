import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject
} from "react";
import { Check } from "lucide-react";

const CONTEXT_MENU_HAPTIC_MS = 20;
const LONG_PRESS_FEEDBACK_DELAY_MS = 200;
const LONG_PRESS_ACTIVE_ATTRIBUTE = "data-context-menu-long-press";

interface VibrationTarget {
  vibrate?: (pattern: number | number[]) => boolean;
}

export function requestContextMenuHaptic(
  target: VibrationTarget | null | undefined = typeof navigator === "undefined" ? undefined : navigator
): boolean {
  if (typeof target?.vibrate !== "function") return false;
  try {
    return target.vibrate(CONTEXT_MENU_HAPTIC_MS);
  } catch {
    return false;
  }
}

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export function clampContextMenuPosition(
  x: number,
  y: number,
  options: { width: number; height: number; edge?: number }
): ContextMenuPosition {
  const edge = options.edge ?? 8;
  return {
    x: Math.max(edge, Math.min(x, window.innerWidth - options.width - edge)),
    y: Math.max(edge, Math.min(y, window.innerHeight - options.height - edge))
  };
}

export function dropdownMenuPosition(
  rect: Pick<DOMRect, "left" | "right" | "bottom">,
  options: { width: number; height: number; align?: "start" | "end"; offset?: number; edge?: number }
): ContextMenuPosition {
  const offset = options.offset ?? 6;
  const x = options.align === "start" ? rect.left : rect.right - options.width;
  return clampContextMenuPosition(x, rect.bottom + offset, options);
}

export function submenuPosition(
  parent: ContextMenuPosition,
  options: { parentWidth: number; width: number; height: number; itemOffsetY: number; edge?: number; gap?: number }
): ContextMenuPosition {
  const edge = options.edge ?? 8;
  const gap = options.gap ?? 4;
  const rightX = parent.x + options.parentWidth + gap;
  const leftX = parent.x - options.width - gap;
  return {
    x: rightX + options.width + edge <= window.innerWidth ? rightX : Math.max(edge, leftX),
    y: Math.max(edge, Math.min(parent.y + options.itemOffsetY, window.innerHeight - options.height - edge))
  };
}

export const ContextMenu = forwardRef<
  HTMLDivElement,
  {
    position: ContextMenuPosition;
    label: string;
    className?: string;
    width?: number;
    style?: CSSProperties;
    children?: ReactNode;
  }
>(function ContextMenu({ position, label, className = "", width, style, children }, ref) {
  return (
    <div
      className={`context-menu${className ? ` ${className}` : ""}`}
      ref={ref}
      style={{ left: position.x, top: position.y, width, ...style }}
      role="menu"
      aria-label={label}
    >
      {children}
    </div>
  );
});

export function ContextMenuItem({
  icon,
  trailing,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" {...props}>
      {icon}
      {children}
      {trailing}
    </button>
  );
}

export function ContextMenuCheckboxItem({
  checked,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role"> & {
  checked: boolean;
}) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} {...props}>
      <span className="menu-check-slot">{checked ? <Check size={15} /> : null}</span>
      {children}
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

export function useDismissableContextMenu(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void
) {
  useEffect(() => {
    if (!open) return undefined;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuRef, onClose, open]);
}

export function useContextMenuTrigger<T>(
  value: T,
  onOpen: (value: T, x: number, y: number) => void,
  options: { longPressMs?: number; moveTolerancePx?: number; disabled?: boolean } = {}
) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerStartRef = useRef<ContextMenuPosition | null>(null);
  const pointerTargetRef = useRef<HTMLElement | null>(null);
  const suppressClickRef = useRef(false);
  const longPressMs = options.longPressMs ?? 600;
  const moveTolerancePx = options.moveTolerancePx ?? 10;

  function clearLongPressFeedback() {
    const target = pointerTargetRef.current;
    if (!target) return;
    target.removeAttribute(LONG_PRESS_ACTIVE_ATTRIBUTE);
    pointerTargetRef.current = null;
  }

  function clearLongPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    pointerStartRef.current = null;
    clearLongPressFeedback();
  }

  useEffect(() => clearLongPress, []);

  function openFromLongPress(x: number, y: number) {
    suppressClickRef.current = true;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    longPressTimerRef.current = null;
    feedbackTimerRef.current = null;
    pointerStartRef.current = null;
    pointerTargetRef.current?.setAttribute(LONG_PRESS_ACTIVE_ATTRIBUTE, "");
    requestContextMenuHaptic();
    onOpen(value, x, y);
  }

  const triggerProps = options.disabled
    ? {}
    : {
        "data-context-menu-trigger": "",
        onContextMenu(event: ReactMouseEvent<HTMLElement>) {
          event.preventDefault();
          clearLongPress();
          onOpen(value, event.clientX, event.clientY);
        },
        onPointerDown(event: ReactPointerEvent<HTMLElement>) {
          if (event.pointerType === "mouse" || event.button !== 0) return;
          clearLongPress();
          pointerStartRef.current = { x: event.clientX, y: event.clientY };
          pointerTargetRef.current = event.currentTarget;
          feedbackTimerRef.current = setTimeout(() => {
            feedbackTimerRef.current = null;
            pointerTargetRef.current?.setAttribute(LONG_PRESS_ACTIVE_ATTRIBUTE, "");
          }, Math.min(LONG_PRESS_FEEDBACK_DELAY_MS, longPressMs));
          longPressTimerRef.current = setTimeout(() => openFromLongPress(event.clientX, event.clientY), longPressMs);
        },
        onPointerMove(event: ReactPointerEvent<HTMLElement>) {
          if (!pointerStartRef.current) return;
          const deltaX = Math.abs(event.clientX - pointerStartRef.current.x);
          const deltaY = Math.abs(event.clientY - pointerStartRef.current.y);
          if (deltaX > moveTolerancePx || deltaY > moveTolerancePx) clearLongPress();
        },
        onPointerUp: clearLongPress,
        onPointerCancel: clearLongPress,
        onPointerLeave: clearLongPress
      };

  return {
    triggerProps,
    consumeSuppressedClick() {
      if (!suppressClickRef.current) return false;
      suppressClickRef.current = false;
      return true;
    }
  };
}
