import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_AGENT_PROVIDER,
  type AgentProviderKind,
  type ProviderAuthState,
  type ProviderDescriptor,
  type ProvidersResponse
} from "@muxpilot/core";
import { api } from "../api/client.js";

export interface ProviderAuthUpdateResult {
  applied: boolean;
  /** True when the update moved a provider from any other state into `ready`. */
  becameReady: boolean;
}

export interface ProvidersState {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  defaultProvider: AgentProviderKind;
  providers: ProviderDescriptor[];
  reload: () => Promise<void>;
  applyAuthUpdate: (state: ProviderAuthState) => ProviderAuthUpdateResult;
  refreshAuth: (kind: AgentProviderKind) => Promise<ProviderAuthState | null>;
  setDefaultProvider: (kind: AgentProviderKind) => Promise<void>;
}

export function useProviders({ connected, connectionEpoch }: { connected: boolean; connectionEpoch: number }): ProvidersState {
  const [response, setResponse] = useState<ProvidersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responseRef = useRef<ProvidersResponse | null>(null);
  const requestIdRef = useRef(0);

  const acceptResponse = useCallback((next: ProvidersResponse) => {
    responseRef.current = next;
    setResponse(next);
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await api.providers();
      if (requestId === requestIdRef.current) acceptResponse(next);
    } catch (cause) {
      if (requestId === requestIdRef.current) setError(cause instanceof Error ? cause.message : "Providers could not be loaded.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [acceptResponse]);

  useEffect(() => {
    if (!connected) return;
    void reload();
  }, [connected, connectionEpoch, reload]);

  const applyAuthUpdate = useCallback((state: ProviderAuthState): ProviderAuthUpdateResult => {
    const current = responseRef.current;
    const descriptor = current?.providers.find((candidate) => candidate.kind === state.provider);
    if (!current || !descriptor || state.revision < descriptor.auth.revision) return { applied: false, becameReady: false };
    const next: ProvidersResponse = {
      ...current,
      providers: current.providers.map((candidate) => candidate.kind === state.provider ? { ...candidate, auth: state } : candidate)
    };
    acceptResponse(next);
    return { applied: true, becameReady: state.status === "ready" && descriptor.auth.status !== "ready" };
  }, [acceptResponse]);

  const refreshAuth = useCallback(async (kind: AgentProviderKind): Promise<ProviderAuthState | null> => {
    const state = await api.refreshProviderAuth(kind);
    applyAuthUpdate(state);
    return state;
  }, [applyAuthUpdate]);

  const setDefaultProvider = useCallback(async (kind: AgentProviderKind) => {
    acceptResponse(await api.setDefaultProvider(kind));
  }, [acceptResponse]);

  return useMemo(() => ({
    loaded: response !== null,
    loading,
    error,
    defaultProvider: response?.defaultProvider ?? DEFAULT_AGENT_PROVIDER,
    providers: response?.providers ?? [],
    reload,
    applyAuthUpdate,
    refreshAuth,
    setDefaultProvider
  }), [applyAuthUpdate, error, loading, refreshAuth, reload, response, setDefaultProvider]);
}

export function isProviderAuthUpdatedEvent(event: { type: string; payload?: unknown }): event is { type: "provider.auth.updated"; payload: ProviderAuthState } {
  if (event.type !== "provider.auth.updated") return false;
  const payload = event.payload as Partial<ProviderAuthState> | null | undefined;
  return Boolean(payload && typeof payload.provider === "string" && typeof payload.revision === "number" && typeof payload.status === "string");
}
