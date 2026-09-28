import {
  AGENT_PROVIDER_KINDS,
  DEFAULT_AGENT_PROVIDER,
  isAgentProviderKind,
  providerDisplayName,
  sessionThreadId,
  type AgentProviderKind,
  type ProviderAccountStatus,
  type ProviderAuthStatus,
  type ProviderDescriptor,
  type ProviderUsageAccount
} from "@muxpilot/core";

export { AGENT_PROVIDER_KINDS, sessionThreadId };
export type { AgentProviderKind };

export const LAST_USED_PROVIDER_STORAGE_KEY = "muxpilot.new-session.provider.v1";

interface ProviderOwner {
  provider?: { kind?: unknown } | null;
}

export function providerLabel(kind: AgentProviderKind | string | null | undefined): string {
  return isAgentProviderKind(kind) ? providerDisplayName(kind) : providerDisplayName(DEFAULT_AGENT_PROVIDER);
}

/** Records written before multi-provider support carry no provider; they are always Codex sessions. */
export function sessionProvider(session: ProviderOwner | null | undefined): AgentProviderKind {
  const kind = session?.provider?.kind;
  return isAgentProviderKind(kind) ? kind : DEFAULT_AGENT_PROVIDER;
}

export function findProvider(
  providers: readonly ProviderDescriptor[] | null | undefined,
  kind: AgentProviderKind
): ProviderDescriptor | null {
  return providers?.find((descriptor) => descriptor.kind === kind) ?? null;
}

export interface ProviderCreateAvailability {
  selectable: boolean;
  /** Why the provider cannot start new sessions; null when selectable. */
  blocking: string | null;
  /** Non-blocking caveat shown while the provider remains selectable. */
  warning: string | null;
  /** Host command that resolves the blocking reason, when it is an authentication problem. */
  loginCommand: string | null;
}

export function providerCreateAvailability(descriptor: ProviderDescriptor | null | undefined): ProviderCreateAvailability {
  if (!descriptor) {
    return { selectable: false, blocking: "Provider status could not be loaded.", warning: null, loginCommand: null };
  }
  const label = descriptor.displayName || providerLabel(descriptor.kind);
  if (!descriptor.enabled) {
    return { selectable: false, blocking: `${label} is disabled on this host.`, warning: null, loginCommand: null };
  }
  const compatibility = descriptor.compatibility;
  if (!compatibility.available) {
    const blocking = compatibility.status === "missing_binary"
      ? `${label} is not installed on this host.`
      : compatibility.detail || `${label} is unavailable on this host.`;
    return { selectable: false, blocking, warning: null, loginCommand: null };
  }
  const auth = descriptor.auth;
  if (auth.status === "signed_out") {
    return {
      selectable: false,
      blocking: `${label} is signed out. Run ${descriptor.loginCommand} on the host, then check again.`,
      warning: null,
      loginCommand: descriptor.loginCommand
    };
  }
  if (auth.status === "authentication_required") {
    return {
      selectable: false,
      blocking: `${label} needs to sign in again. Run ${descriptor.loginCommand} on the host, then check again.`,
      warning: null,
      loginCommand: descriptor.loginCommand
    };
  }
  if (auth.status === "checking") {
    return { selectable: true, blocking: null, warning: `Checking ${label} authentication…`, loginCommand: null };
  }
  if (auth.status === "temporarily_unavailable") {
    return {
      selectable: true,
      blocking: null,
      warning: `${label} authentication could not be verified${auth.error ? `: ${auth.error}` : ""}. New sessions start once it recovers.`,
      loginCommand: null
    };
  }
  return { selectable: true, blocking: null, warning: null, loginCommand: null };
}

export function resolveInitialProvider({
  parent,
  lastUsed,
  serverDefault,
  providers
}: {
  parent?: AgentProviderKind | null;
  lastUsed?: AgentProviderKind | null;
  serverDefault?: AgentProviderKind | null;
  providers: readonly ProviderDescriptor[];
}): AgentProviderKind {
  const preferred = [parent, lastUsed, serverDefault].filter((kind): kind is AgentProviderKind => isAgentProviderKind(kind));
  const candidates = [...preferred, ...providers.map((descriptor) => descriptor.kind)];
  const selectable = candidates.find((kind) => providerCreateAvailability(findProvider(providers, kind)).selectable);
  return selectable ?? preferred[0] ?? providers[0]?.kind ?? DEFAULT_AGENT_PROVIDER;
}

export function loadLastUsedProvider(): AgentProviderKind | null {
  try {
    const value = window.localStorage.getItem(LAST_USED_PROVIDER_STORAGE_KEY);
    return isAgentProviderKind(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLastUsedProvider(kind: AgentProviderKind): void {
  try {
    window.localStorage.setItem(LAST_USED_PROVIDER_STORAGE_KEY, kind);
  } catch {
    // The dialog falls back to the server default when storage is unavailable.
  }
}

export function providerCompatibilityLabel(descriptor: ProviderDescriptor | null | undefined): string {
  if (!descriptor) return "Provider status could not be loaded.";
  const label = descriptor.displayName || providerLabel(descriptor.kind);
  const compatibility = descriptor.compatibility;
  if (compatibility.available) return compatibility.version ? `${label} ${compatibility.version} is available.` : `${label} is available.`;
  if (compatibility.status === "missing_binary") return `${label} is not installed on this host.`;
  return compatibility.detail || `${label} is unavailable on this host.`;
}

/** The reason a provider cannot run sessions, or null when its runtime is available. */
export function providerUnavailableReason(descriptor: ProviderDescriptor | null | undefined, kind: AgentProviderKind = DEFAULT_AGENT_PROVIDER): string | null {
  if (!descriptor) return `${providerLabel(kind)} status could not be loaded.`;
  if (descriptor.enabled && descriptor.compatibility.available) return null;
  return providerCompatibilityLabel(descriptor);
}

/** Usage polling runs only for installed providers that report account limits. */
export function providerUsageEnabled(descriptor: ProviderDescriptor | null | undefined): boolean {
  return Boolean(descriptor?.enabled && descriptor.compatibility.available && descriptor.capabilities.usageLimits);
}

export function providerAuthStatusLabel(status: ProviderAuthStatus): string {
  if (status === "ready") return "Signed in";
  if (status === "checking") return "Checking sign-in";
  if (status === "signed_out") return "Signed out";
  if (status === "authentication_required") return "Sign-in required";
  return "Sign-in unverified";
}

export function formatUsageAccount(
  kind: AgentProviderKind,
  account: ProviderUsageAccount | null,
  accountStatus: ProviderAccountStatus = "unknown"
): string {
  if (!account) return accountStatus === "signed_out" ? "Not signed in" : "Account status unavailable";
  const accountKind = account.kind.toLowerCase();
  if (accountKind === "apikey" || accountKind === "api_key" || accountKind === "console") return "API key";
  if (accountKind === "amazonbedrock" || accountKind === "bedrock") return "Amazon Bedrock";
  if (accountKind === "vertex" || accountKind === "googlevertex") return "Google Vertex AI";
  if (account.email) return account.email;
  if (kind === "codex" && accountKind === "chatgpt") return "ChatGPT";
  if (kind === "claude" && (accountKind === "claudeai" || accountKind === "claude_ai" || accountKind === "oauth")) return "Claude account";
  return "Unknown account";
}

/** Provider badges add noise on single-provider hosts, so they appear only once providers can differ. */
export function shouldShowProviderBadges(
  providers: readonly ProviderDescriptor[] | null | undefined,
  sessions: readonly ProviderOwner[] = []
): boolean {
  if ((providers ?? []).filter((descriptor) => descriptor.enabled).length > 1) return true;
  return new Set(sessions.map(sessionProvider)).size > 1;
}
