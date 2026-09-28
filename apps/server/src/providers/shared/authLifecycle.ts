import { watch, type FSWatcher } from "node:fs";
import type { Logger } from "pino";
import type {
  AgentProviderKind,
  ProviderAuthAccount,
  ProviderAuthState,
  ProviderAuthStatus
} from "@muxpilot/core";
import type { AppDatabase } from "../../db/database.js";
import type { EventBus } from "../../services/eventBus.js";
import { eventId } from "../../utils/ids.js";
import { nowIso } from "../../utils/time.js";

const RECONCILE_INTERVAL_MS = 15_000;
const WATCH_DEBOUNCE_MS = 250;

export type ProviderAuthDatabase = Pick<AppDatabase, "getProviderAuthReconciledPrincipal" | "setProviderAuthReconciledPrincipal">;

/** One observation of the provider's CLI-managed account. */
export interface ProviderAuthObservation {
  status: Exclude<ProviderAuthStatus, "checking">;
  account: ProviderAuthAccount | null;
  /**
   * Stable fingerprint of the signed-in principal, or null when signed out. It must not change on ordinary
   * token refreshes, only when a different account (or credential kind) becomes active.
   */
  principal: string | null;
  error: string | null;
}

/** Provider-specific account observation used by the shared authentication state machine. */
export interface ProviderAuthObserver {
  readonly provider: AgentProviderKind;
  readonly displayName: string;
  /** Credential files whose changes should trigger a fresh observation. */
  readonly credentialWatch: { directory: string; filenames: string[] } | null;
  observe(reason: string): Promise<ProviderAuthObservation>;
  isAuthenticationError(message: string): boolean;
  /** Operator guidance appended to a sanitized authentication error. */
  recoveryMessage(message: string): string;
  prepare?(): Promise<void>;
  stop(): void;
}

export interface ProviderAuthRuntimeHooks {
  blockers(): Promise<string[]>;
  reconcile(sessionIds: readonly string[] | null): Promise<string[]>;
  suspend(): Promise<string[]>;
  invalidateConsumers(): void;
  admissionReleased(): void;
}

export interface ProviderAuthLifecycleOptions {
  reconcileIntervalMs?: number | null;
  watchCredentials?: boolean;
}

export class ProviderAuthUnavailableError extends Error {
  constructor(message: string, readonly statusCode = 503) {
    super(message);
  }
}

/**
 * Tracks one provider's CLI-managed authentication. A principal change holds session admission, lets live
 * sessions reach a safe boundary, and only releases admission once every affected runtime is reconciled.
 */
export class ProviderAuthLifecycle {
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private hooks: ProviderAuthRuntimeHooks | null = null;
  private operation: Promise<void> = Promise.resolve();
  private reconciliationPending = false;
  private reconciliationSessionIds: string[] | null = null;
  private reconciliationObservedGeneration: number | null = null;
  private changeGeneration = 0;
  private lastObservedGeneration = 0;
  private lastObservedPrincipal: string | null = null;
  private reconciledPrincipal: string | null = null;
  private stateValue: ProviderAuthState;
  private readonly reconcileIntervalMs: number | null;
  private readonly watchCredentials: boolean;

  constructor(
    private readonly db: ProviderAuthDatabase,
    private readonly events: Pick<EventBus, "publish">,
    readonly observer: ProviderAuthObserver,
    private readonly logger?: Pick<Logger, "warn" | "debug">,
    options: ProviderAuthLifecycleOptions = {}
  ) {
    this.reconcileIntervalMs = options.reconcileIntervalMs === undefined ? RECONCILE_INTERVAL_MS : options.reconcileIntervalMs;
    this.watchCredentials = options.watchCredentials ?? true;
    this.stateValue = {
      provider: observer.provider,
      status: "checking",
      account: null,
      revision: 0,
      observedAt: nowIso(),
      error: null,
      admissionHeld: true,
      pendingSessionIds: []
    };
  }

  get provider(): AgentProviderKind {
    return this.observer.provider;
  }

  async start(): Promise<void> {
    await this.observer.prepare?.();
    this.reconciledPrincipal = await this.db.getProviderAuthReconciledPrincipal(this.provider);
    await this.observeAndReconcile("startup", true, true);
    const credentialWatch = this.observer.credentialWatch;
    if (this.watchCredentials && credentialWatch) {
      try {
        this.watcher = watch(credentialWatch.directory, { persistent: false }, (_event, filename) => {
          if (!credentialWatch.filenames.includes(filename?.toString() ?? "")) return;
          this.signalExternalChange();
          if (this.watchTimer) clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => {
            this.watchTimer = null;
            void this.serialize(() => this.observeAndReconcile("external credential change"));
          }, WATCH_DEBOUNCE_MS);
        });
      } catch (error) {
        // A missing credential directory is ordinary before first login; periodic reconciliation still observes it.
        this.logger?.debug({ err: error, provider: this.provider }, "credential directory is not watchable");
      }
    }
    if (this.reconcileIntervalMs !== null) {
      this.interval = setInterval(
        () => void this.serialize(() => this.observeAndReconcile("periodic reconciliation")),
        this.reconcileIntervalMs
      );
    }
  }

  setRuntimeHooks(hooks: ProviderAuthRuntimeHooks): void {
    this.hooks = hooks;
  }

  state(): ProviderAuthState {
    return { ...this.stateValue, account: this.stateValue.account ? { ...this.stateValue.account } : null };
  }

  assertAvailable(): void {
    if (this.stateValue.status !== "ready") throw new ProviderAuthUnavailableError(this.unavailableMessage());
  }

  assertReady(): void {
    this.assertAvailable();
    if (this.stateValue.admissionHeld) throw new ProviderAuthUnavailableError(this.unavailableMessage());
  }

  async refresh(): Promise<ProviderAuthState> {
    await this.serialize(() => this.observeAndReconcile("manual refresh"));
    return this.state();
  }

  async reconcileAfterStartup(): Promise<void> {
    if (this.reconciliationPending) {
      await this.serialize(() => this.reconcileObservedState(this.lastObservedGeneration));
    }
  }

  async stop(): Promise<void> {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.interval) clearInterval(this.interval);
    this.watcher?.close();
    this.observer.stop();
    await this.operation.catch(() => undefined);
  }

  reportAuthenticationFailure(error: unknown): void {
    const message = sanitizeCredentialText(errorMessage(error));
    if (!this.observer.isAuthenticationError(message)) return;
    this.changeGeneration += 1;
    this.reconciliationPending = true;
    this.update({ status: "authentication_required", admissionHeld: true, error: this.observer.recoveryMessage(message) });
    this.hooks?.invalidateConsumers();
    void this.serialize(() => this.observeAndReconcile("runtime authentication failure"));
  }

  reportAccountUpdated(): void {
    this.signalExternalChange();
    void this.serialize(() => this.observeAndReconcile(`${this.observer.displayName} account update notification`));
  }

  private unavailableMessage(): string {
    return this.stateValue.error
      ?? `${this.observer.displayName} authentication is being reconciled. Try again when the account is ready.`;
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.catch(() => undefined).then(operation);
    this.operation = next.catch((error) => {
      this.logger?.warn({ err: error, provider: this.provider }, "provider authentication reconciliation failed");
    });
    return next;
  }

  private async observeAndReconcile(reason: string, deferReconciliation = false, startup = false): Promise<void> {
    const observedGeneration = this.changeGeneration;
    const previousStatus = this.stateValue.status;
    const previousPrincipal = this.lastObservedPrincipal;
    let observation: ProviderAuthObservation;
    try {
      observation = await this.observer.observe(reason);
    } catch (cause) {
      const message = sanitizeCredentialText(errorMessage(cause));
      const authenticationRequired = this.observer.isAuthenticationError(message);
      observation = {
        status: authenticationRequired ? "authentication_required" : "temporarily_unavailable",
        account: null,
        principal: null,
        error: authenticationRequired ? this.observer.recoveryMessage(message) : message
      };
    }
    const { status, account, principal, error } = observation;
    this.lastObservedGeneration = observedGeneration;
    const changed = previousPrincipal !== principal || previousStatus !== status;
    this.lastObservedPrincipal = principal;

    if (startup) {
      this.update({ status, account, admissionHeld: true, error });
      if (status === "ready" && (this.reconciledPrincipal === null || this.reconciledPrincipal === principal)) {
        await this.persistReconciledPrincipal(principal);
        this.reconciliationPending = false;
        this.reconciliationSessionIds = [];
        this.reconciliationObservedGeneration = observedGeneration;
        this.update({ admissionHeld: false, pendingSessionIds: [], error: null });
        this.hooks?.admissionReleased();
        return;
      }
      this.reconciliationPending = true;
      this.reconciliationSessionIds = null;
      this.reconciliationObservedGeneration = observedGeneration;
      this.update({ admissionHeld: true });
      this.hooks?.invalidateConsumers();
      return;
    }

    if (!changed && !this.reconciliationPending) {
      this.stateValue = { ...this.stateValue, status, account, error, observedAt: nowIso() };
      return;
    }
    if (!this.reconciliationPending) {
      this.reconciliationPending = true;
      this.reconciliationSessionIds = null;
      this.reconciliationObservedGeneration = observedGeneration;
      this.update({ status: "checking", admissionHeld: true, error: null });
      this.hooks?.invalidateConsumers();
    } else if (changed && this.reconciliationObservedGeneration !== observedGeneration) {
      this.reconciliationSessionIds = null;
      this.reconciliationObservedGeneration = observedGeneration;
    }
    this.update({ status, account, admissionHeld: true, error });
    if (deferReconciliation) return;
    await this.reconcileObservedState(observedGeneration);
  }

  private async reconcileObservedState(observedGeneration = this.changeGeneration): Promise<void> {
    if (this.stateValue.status === "ready") {
      if (this.reconciliationObservedGeneration !== observedGeneration) {
        this.reconciliationSessionIds = null;
        this.reconciliationObservedGeneration = observedGeneration;
      }
      const pending = await this.hooks?.reconcile(this.reconciliationSessionIds) ?? [];
      this.reconciliationSessionIds = pending;
      const newerChangePending = observedGeneration !== this.changeGeneration;
      const complete = pending.length === 0 && !newerChangePending;
      if (complete) await this.persistReconciledPrincipal(this.lastObservedPrincipal);
      this.reconciliationPending = pending.length > 0 || newerChangePending;
      this.update({
        admissionHeld: pending.length > 0 || newerChangePending,
        pendingSessionIds: pending,
        error: pending.length > 0 ? "Waiting for active sessions to reach a safe boundary." : null
      });
      if (complete) this.hooks?.admissionReleased();
      return;
    }
    const pending = this.stateValue.status === "signed_out" || this.stateValue.status === "authentication_required"
      ? await this.hooks?.suspend() ?? []
      : await this.hooks?.blockers() ?? [];
    this.reconciliationPending = true;
    this.update({ admissionHeld: true, pendingSessionIds: pending });
  }

  private signalExternalChange(): void {
    // A write can be an ordinary access-token refresh. Observe the resulting
    // principal before holding admission or replacing any session runtimes.
    this.changeGeneration += 1;
  }

  private async persistReconciledPrincipal(principal: string | null): Promise<void> {
    if (principal === null || principal === this.reconciledPrincipal) return;
    await this.db.setProviderAuthReconciledPrincipal(this.provider, principal, nowIso());
    this.reconciledPrincipal = principal;
  }

  private update(changes: Partial<ProviderAuthState>): void {
    this.stateValue = {
      ...this.stateValue,
      ...changes,
      revision: this.stateValue.revision + 1,
      observedAt: changes.observedAt ?? nowIso()
    };
    this.events.publish({
      id: eventId(),
      type: "provider.auth.updated",
      sessionId: "__app__",
      payload: this.state(),
      timestamp: this.stateValue.observedAt
    });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Redacts credential-shaped values before an error reaches logs, events, or the UI. */
export function sanitizeCredentialText(message: string): string {
  return message
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[credential redacted]")
    .replace(/(?:sk-ant-|sk-|sess-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .slice(0, 1_000);
}
