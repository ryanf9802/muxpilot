import { isAgentProviderKind, providerDisplayName, type AgentProviderKind, type ManagedSession } from "@muxpilot/core";
import type { AgentProvider, AgentSessionDriver } from "./types.js";

export class UnknownProviderError extends Error {
  readonly statusCode = 404;
}

export class ProviderUnavailableError extends Error {
  readonly statusCode = 503;
}

/** Enabled providers keyed by kind. Sessions are routed by `session.provider.kind`. */
export class ProviderRegistry {
  private readonly providers = new Map<AgentProviderKind, AgentProvider>();

  constructor(providers: AgentProvider[] = [], private defaultKind: AgentProviderKind = providers[0]?.kind ?? "codex") {
    for (const provider of providers) {
      if (this.providers.has(provider.kind)) throw new Error(`Provider ${provider.kind} is already registered`);
      this.providers.set(provider.kind, provider);
    }
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  maybe(kind: AgentProviderKind): AgentProvider | null {
    return this.providers.get(kind) ?? null;
  }

  get(kind: unknown): AgentProvider {
    const provider = isAgentProviderKind(kind) ? this.providers.get(kind) : undefined;
    if (!provider) throw new UnknownProviderError(`Unknown or disabled provider: ${String(kind)}`);
    return provider;
  }

  forSession(session: Pick<ManagedSession, "provider">): AgentProvider {
    return this.get(session.provider.kind);
  }

  /** True when any provider can launch sessions. */
  hasDrivers(): boolean {
    return this.list().some((provider) => provider.driver !== null);
  }

  maybeDriver(kind: AgentProviderKind): AgentSessionDriver | null {
    return this.maybe(kind)?.driver ?? null;
  }

  driver(kind: AgentProviderKind): AgentSessionDriver {
    const provider = this.maybe(kind);
    if (!provider) throw new UnknownProviderError(`${providerDisplayName(kind)} sessions are not enabled on this muxpilot host`);
    if (!provider.driver) {
      throw new ProviderUnavailableError(`${provider.displayName} sessions are unavailable: ${provider.compatibility().detail}`);
    }
    return provider.driver;
  }

  driverFor(session: Pick<ManagedSession, "provider">): AgentSessionDriver {
    return this.driver(session.provider.kind);
  }

  defaultProvider(): AgentProviderKind {
    return this.providers.has(this.defaultKind) ? this.defaultKind : this.list()[0]?.kind ?? this.defaultKind;
  }

  setDefaultProvider(kind: AgentProviderKind): void {
    this.get(kind);
    this.defaultKind = kind;
  }
}
