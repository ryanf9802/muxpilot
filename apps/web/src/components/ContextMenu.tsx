import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject
} from "react";

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

export const ContextMenu = forwardRef<
  HTMLDivElement,
  {
    position: ContextMenuPosition;
    label: string;
    className?: string;
    width?: number;
    children?: ReactNode;
  }
>(function ContextMenu({ position, label, className = "", width, children }, ref) {
  return (
    <div
      className={`context-menu${className ? ` ${className}` : ""}`}
      ref={ref}
      style={{ left: position.x, top: position.y, width }}
      role="menu"
      aria-label={label}
    >
      {children}
    </div>
  );
});

export function ContextMenuItem({
  icon,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" {...props}>
      {icon}
      {children}
    </button>
  );
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
  const pointerStartRef = useRef<ContextMenuPosition | null>(null);
  const suppressClickRef = useRef(false);
  const longPressMs = options.longPressMs ?? 600;
  const moveTolerancePx = options.moveTolerancePx ?? 10;

  function clearLongPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pointerStartRef.current = null;
  }

  useEffect(() => clearLongPress, []);

  function openFromLongPress(x: number, y: number) {
    suppressClickRef.current = true;
    clearLongPress();
    onOpen(value, x, y);
  }

  const triggerProps = options.disabled
    ? {}
    : {
        onContextMenu(event: ReactMouseEvent<HTMLElement>) {
          event.preventDefault();
          clearLongPress();
          onOpen(value, event.clientX, event.clientY);
        },
        onPointerDown(event: ReactPointerEvent<HTMLElement>) {
          if (event.pointerType === "mouse" || event.button !== 0) return;
          pointerStartRef.current = { x: event.clientX, y: event.clientY };
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
