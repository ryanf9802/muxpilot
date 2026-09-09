import { LoaderCircle } from "lucide-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode
} from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  busy?: boolean;
  busyLabel?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "secondary",
  size = "medium",
  icon,
  busy = false,
  busyLabel,
  className = "",
  disabled,
  children,
  type = "button",
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`app-button app-button-${variant} app-button-${size}${className ? ` ${className}` : ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-busy={busy || undefined}
    >
      <span className="app-button-icon" aria-hidden="true">
        {busy ? <LoaderCircle className="spin" size={16} /> : icon}
      </span>
      <span>{busy && busyLabel !== undefined ? busyLabel : children}</span>
    </button>
  );
});

export function DialogActions({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`dialog-actions${className ? ` ${className}` : ""}`} />;
}
