import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderAuthState, ProviderDescriptor } from "@muxpilot/core";
import { copyText } from "../utils/clipboard.js";
import { providerAuthStatusLabel, providerLabel } from "../utils/providers.js";
import { Button } from "./Button.js";

export function ProviderAuthStatus({ auth }: { auth: Pick<ProviderAuthState, "provider" | "status"> }) {
  return (
    <span className="provider-auth-status" data-status={auth.status} data-provider={auth.provider}>
      <span className="provider-auth-status-dot" aria-hidden="true" />
      {providerAuthStatusLabel(auth.status)}
    </span>
  );
}

export function providerAuthCalloutMessage(descriptor: Pick<ProviderDescriptor, "kind" | "displayName" | "auth">): string | null {
  const label = descriptor.displayName || providerLabel(descriptor.kind);
  const { status, error } = descriptor.auth;
  if (status === "signed_out") return `${label} is not signed in on this host.`;
  if (status === "authentication_required") return `${label} needs to sign in again before sessions can continue.`;
  if (status === "temporarily_unavailable") return `${label} sign-in could not be verified${error ? `: ${error}` : "."}`;
  if (status === "checking") return `Checking ${label} sign-in…`;
  return null;
}

/**
 * Explains a non-ready provider sign-in. Authentication is managed by the provider CLI on the host,
 * so the callout offers the login command to copy rather than an in-browser sign-in flow.
 */
export function ProviderAuthCallout({
  descriptor,
  onCheckAgain
}: {
  descriptor: Pick<ProviderDescriptor, "kind" | "displayName" | "auth" | "loginCommand">;
  onCheckAgain?: () => Promise<unknown> | void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const message = providerAuthCalloutMessage(descriptor);
  if (!message) return null;
  const needsLogin = descriptor.auth.status === "signed_out" || descriptor.auth.status === "authentication_required";

  async function checkAgain() {
    if (!onCheckAgain || checking) return;
    setChecking(true);
    setError(null);
    try {
      await onCheckAgain();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in status could not be refreshed.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="provider-auth-callout" data-status={descriptor.auth.status} data-provider={descriptor.kind} role="status">
      <p>{message}</p>
      {needsLogin ? (
        <div className="provider-auth-callout-command">
          <span>Run on the host</span>
          <CopyableCommand command={descriptor.loginCommand} />
        </div>
      ) : null}
      {error ? <p className="provider-auth-callout-error" role="alert">{error}</p> : null}
      {onCheckAgain && descriptor.auth.status !== "checking" ? (
        <Button size="small" icon={<RefreshCw size={14} />} onClick={() => void checkAgain()} busy={checking} busyLabel="Checking">
          Check again
        </Button>
      ) : null}
    </div>
  );
}

export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <span className="copyable-command">
      <code>{command}</code>
      <button
        type="button"
        className="copyable-command-button"
        aria-label={copied ? `Copied ${command}` : `Copy ${command}`}
        title={copied ? "Copied" : "Copy command"}
        onClick={() => void copyText(command).then(() => setCopied(true)).catch(() => undefined)}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </span>
  );
}
