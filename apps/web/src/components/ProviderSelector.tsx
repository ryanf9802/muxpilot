import { useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AgentProviderKind, ProviderDescriptor } from "@muxpilot/core";
import { providerAuthStatusLabel, providerCompatibilityLabel, providerCreateAvailability, providerLabel } from "../utils/providers.js";
import { CopyableCommand } from "./ProviderAuth.js";
import { Button } from "./Button.js";

export function providerOptionStatus(descriptor: ProviderDescriptor): string {
  if (!descriptor.enabled) return "Disabled";
  if (!descriptor.compatibility.available) return descriptor.compatibility.status === "missing_binary" ? "Not installed" : "Unavailable";
  if (descriptor.auth.status !== "ready") return providerAuthStatusLabel(descriptor.auth.status);
  return descriptor.compatibility.version ? `Ready · ${descriptor.compatibility.version}` : "Ready";
}

/**
 * Segmented provider radiogroup for new sessions. Unavailable providers stay visible with their status,
 * but arrow-key navigation skips them and they cannot be chosen.
 */
export function ProviderSelector({
  providers,
  value,
  disabled = false,
  onChange,
  onCheckAuth
}: {
  providers: ProviderDescriptor[];
  value: AgentProviderKind;
  disabled?: boolean;
  onChange: (provider: AgentProviderKind) => void;
  onCheckAuth?: (provider: AgentProviderKind) => Promise<unknown>;
}) {
  const labelId = useId();
  const optionRefs = useRef(new Map<AgentProviderKind, HTMLButtonElement>());
  const selected = providers.find((descriptor) => descriptor.kind === value) ?? null;
  const availability = providerCreateAvailability(selected);

  if (providers.length <= 1) {
    return (
      <div className="provider-selector provider-selector-single">
        <p className="session-git-probe-note" data-status={selected?.compatibility.status}>{providerCompatibilityLabel(selected)}</p>
        <ProviderSelectorNote provider={value} availability={availability} onCheckAuth={onCheckAuth} />
      </div>
    );
  }

  function selectable(descriptor: ProviderDescriptor): boolean {
    return !disabled && providerCreateAvailability(descriptor).selectable;
  }

  function choose(descriptor: ProviderDescriptor) {
    if (!selectable(descriptor)) return;
    onChange(descriptor.kind);
    optionRefs.current.get(descriptor.kind)?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const ordered = event.key === "Home" ? providers : [...providers].reverse();
      const target = ordered.find(selectable);
      if (target) choose(target);
      return;
    }
    if (!step) return;
    event.preventDefault();
    for (let offset = 1; offset < providers.length; offset += 1) {
      const candidate = providers[(index + step * offset + providers.length * offset) % providers.length];
      if (candidate && selectable(candidate)) {
        choose(candidate);
        return;
      }
    }
  }

  return (
    <div className="provider-selector">
      <span className="provider-selector-label" id={labelId}>Provider</span>
      <div className="provider-selector-options" role="radiogroup" aria-labelledby={labelId}>
        {providers.map((descriptor, index) => {
          const checked = descriptor.kind === value;
          const optionDisabled = !selectable(descriptor);
          return (
            <button
              key={descriptor.kind}
              ref={(element) => {
                if (element) optionRefs.current.set(descriptor.kind, element);
                else optionRefs.current.delete(descriptor.kind);
              }}
              type="button"
              role="radio"
              className="provider-selector-option"
              data-provider={descriptor.kind}
              data-status={descriptor.auth.status}
              aria-checked={checked}
              aria-disabled={optionDisabled || undefined}
              tabIndex={checked ? 0 : -1}
              title={providerCreateAvailability(descriptor).blocking ?? undefined}
              onClick={() => choose(descriptor)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              <span className="provider-selector-name">
                <span className="provider-badge-dot" aria-hidden="true" />
                {descriptor.displayName || providerLabel(descriptor.kind)}
              </span>
              <span className="provider-selector-status">{providerOptionStatus(descriptor)}</span>
            </button>
          );
        })}
      </div>
      <ProviderSelectorNote provider={value} availability={availability} onCheckAuth={onCheckAuth} />
    </div>
  );
}

function ProviderSelectorNote({
  provider,
  availability,
  onCheckAuth
}: {
  provider: AgentProviderKind;
  availability: ReturnType<typeof providerCreateAvailability>;
  onCheckAuth?: (provider: AgentProviderKind) => Promise<unknown>;
}) {
  if (!availability.blocking && !availability.warning) return null;
  return (
    <div className="provider-selector-note" data-tone={availability.blocking ? "error" : "warning"} role="note">
      <p>{availability.blocking ?? availability.warning}</p>
      {availability.loginCommand ? <CopyableCommand command={availability.loginCommand} /> : null}
      {availability.loginCommand && onCheckAuth ? (
        <Button size="small" onClick={() => void onCheckAuth(provider).catch(() => undefined)}>Check again</Button>
      ) : null}
    </div>
  );
}
