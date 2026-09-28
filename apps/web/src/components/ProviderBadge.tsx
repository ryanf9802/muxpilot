import type { AgentProviderKind } from "@muxpilot/core";
import { providerLabel } from "../utils/providers.js";

export function ProviderBadge({
  provider,
  iconOnly = false,
  className = ""
}: {
  provider: AgentProviderKind;
  /** Renders only the provider color mark, for places that already name the provider. */
  iconOnly?: boolean;
  className?: string;
}) {
  const label = providerLabel(provider);
  return (
    <span
      className={`provider-badge${iconOnly ? " provider-badge-icon" : ""}${className ? ` ${className}` : ""}`}
      data-provider={provider}
      title={`${label} provider`}
      aria-label={`${label} provider`}
      role="img"
    >
      <span className="provider-badge-dot" aria-hidden="true" />
      {iconOnly ? null : <span className="provider-badge-label" aria-hidden="true">{label}</span>}
    </span>
  );
}
