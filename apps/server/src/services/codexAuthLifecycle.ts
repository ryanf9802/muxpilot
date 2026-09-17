import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Logger } from "pino";
import type { CodexAuthAccount, CodexAuthState } from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import { EventBus } from "./eventBus.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { CodexAppServerClient, type AccountReadResponse } from "./codexUsage.js";

const RECONCILE_INTERVAL_MS = 15_000;
const WATCH_DEBOUNCE_MS = 250;

type AuthClient = Pick<CodexAppServerClient, "request" | "stop">;
type AuthDatabase = Pick<
  AppDatabase,
  "clearCodexAuthProfiles" | "getCodexAuthReconciledPrincipal" | "setCodexAuthReconciledPrincipal"
>;

export interface CodexAuthRuntimeHooks {
  blockers(): Promise<string[]>;
  reconcile(sessionIds: readonly string[] | null): Promise<string[]>;
  suspend(): Promise<string[]>;
  invalidateConsumers(): void;
  admissionReleased(): void;
}

export interface CodexAuthLifecycleOptions {
  client?: AuthClient;
  reconcileIntervalMs?: number | null;
  watchCredentials?: boolean;
}

export class CodexAuthUnavailableError extends Error {
  constructor(message: string, readonly statusCode = 503) {
    super(message);
  }
}

export class CodexAuthLifecycle {
  private readonly authPath: string;
  private readonly profileRoot: string;
  private readonly loginRoot: string;
  private readonly client: AuthClient;
  private readonly reconcileIntervalMs: number | null;
  private readonly watchCredentials: boolean;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private hooks: CodexAuthRuntimeHooks | null = null;
  private operation: Promise<void> = Promise.resolve();
  private reconciliationPending = false;
  private reconciliationSessionIds: string[] | null = null;
  private reconciliationObservedGeneration: number | null = null;
  private changeGeneration = 0;
  private lastObservedGeneration = 0;
  private lastObservedPrincipal: string | null = null;
  private reconciledPrincipal: string | null = null;
  private stateValue: CodexAuthState;

  constructor(
    private readonly db: AuthDatabase,
    private readonly events: EventBus,
    codexHome: string,
    private readonly dataDir: string,
    private readonly logger?: Pick<Logger, "warn" | "debug">,
    options: CodexAuthLifecycleOptions = {}
  ) {
    this.authPath = join(codexHome, "auth.json");
    this.profileRoot = join(dataDir, "private", "codex-auth-profiles");
    this.loginRoot = join(dataDir, "runtime", "codex-auth-logins");
    this.client = options.client ?? new CodexAppServerClient({ codexHome, timeoutMs: 15_000, logger });
    this.reconcileIntervalMs = options.reconcileIntervalMs === undefined ? RECONCILE_INTERVAL_MS : options.reconcileIntervalMs;
    this.watchCredentials = options.watchCredentials ?? true;
    this.stateValue = {
      status: "checking",
      account: null,
      revision: 0,
      observedAt: nowIso(),
      error: null,
      admissionHeld: true,
      pendingSessionIds: []
    };
  }

  async start(): Promise<void> {
    await this.removeLegacyAccountData();
    this.reconciledPrincipal = await this.db.getCodexAuthReconciledPrincipal();
    await this.observeAndReconcile("startup", false, true, true);
    if (this.watchCredentials) {
      this.watcher = watch(dirname(this.authPath), { persistent: false }, (_event, filename) => {
        if (filename?.toString() !== "auth.json") return;
        this.signalExternalChange();
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.serialize(() => this.observeAndReconcile("external credential change", true));
        }, WATCH_DEBOUNCE_MS);
      });
    }
    if (this.reconcileIntervalMs !== null) {
      this.interval = setInterval(
        () => void this.serialize(() => this.observeAndReconcile("periodic reconciliation", false)),
        this.reconcileIntervalMs
      );
    }
  }

  setRuntimeHooks(hooks: CodexAuthRuntimeHooks): void {
    this.hooks = hooks;
  }

  state(): CodexAuthState {
    return { ...this.stateValue, account: this.stateValue.account ? { ...this.stateValue.account } : null };
  }

  assertAvailable(): void {
    if (this.stateValue.status !== "ready") {
      throw new CodexAuthUnavailableError(this.stateValue.error ?? "Codex authentication is being reconciled. Try again when the account is ready.");
    }
  }

  assertReady(): void {
    this.assertAvailable();
    if (this.stateValue.admissionHeld) {
      throw new CodexAuthUnavailableError(this.stateValue.error ?? "Codex authentication is being reconciled. Try again when the account is ready.");
    }
  }

  async refresh(): Promise<CodexAuthState> {
    await this.serialize(() => this.observeAndReconcile("manual refresh", true));
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
    this.client.stop();
    await this.operation.catch(() => undefined);
  }

  reportAuthenticationFailure(error: unknown): void {
    const message = sanitizeError(errorMessage(error));
    if (!isAuthenticationError(message)) return;
    this.changeGeneration += 1;
    this.reconciliationPending = true;
    this.update({ status: "authentication_required", admissionHeld: true, error: cliRecoveryMessage(message) });
    this.hooks?.invalidateConsumers();
    void this.serialize(() => this.observeAndReconcile("runtime authentication failure", true));
  }

  reportAccountUpdated(): void {
    this.signalExternalChange();
    void this.serialize(() => this.observeAndReconcile("Codex account update notification", true));
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.catch(() => undefined).then(operation);
    this.operation = next.catch((error) => {
      this.logger?.warn({ err: error }, "Codex authentication reconciliation failed");
    });
    return next;
  }

  private async observeAndReconcile(
    reason: string,
    forceTokenRefresh: boolean,
    deferReconciliation = false,
    startup = false
  ): Promise<void> {
    const observedGeneration = this.changeGeneration;
    const previousStatus = this.stateValue.status;
    const previousPrincipal = this.lastObservedPrincipal;

    this.client.stop(new Error(`Codex authentication observer refreshed: ${reason}`));
    let account: CodexAuthAccount | null = null;
    let requiresOpenaiAuth = true;
    let status: CodexAuthState["status"];
    let error: string | null = null;
    try {
      const response = await this.client.request<AccountReadResponse>("account/read", { refreshToken: forceTokenRefresh });
      account = normalizeAccount(response.account);
      requiresOpenaiAuth = response.requiresOpenaiAuth;
      status = account || !response.requiresOpenaiAuth ? "ready" : "signed_out";
      if (status === "signed_out") error = "Codex authentication is required. Sign in with the Codex CLI, then return to muxpilot.";
    } catch (cause) {
      const message = sanitizeError(errorMessage(cause));
      status = isAuthenticationError(message) ? "authentication_required" : "temporarily_unavailable";
      error = status === "authentication_required" ? cliRecoveryMessage(message) : message;
    }
    const principal = await authPrincipalFingerprint(this.authPath, account, requiresOpenaiAuth);
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
    await this.db.setCodexAuthReconciledPrincipal(principal, nowIso());
    this.reconciledPrincipal = principal;
  }

  private async removeLegacyAccountData(): Promise<void> {
    await Promise.all([
      removeOwnedPath(this.dataDir, this.profileRoot),
      removeOwnedPath(this.dataDir, this.loginRoot),
      this.db.clearCodexAuthProfiles()
    ]);
  }

  private update(changes: Partial<CodexAuthState>): void {
    this.stateValue = {
      ...this.stateValue,
      ...changes,
      revision: this.stateValue.revision + 1,
      observedAt: changes.observedAt ?? nowIso()
    };
    this.events.publish({ id: eventId(), type: "codex.auth.updated", sessionId: "__app__", payload: this.state(), timestamp: this.stateValue.observedAt });
  }
}

function normalizeAccount(account: AccountReadResponse["account"]): CodexAuthAccount | null {
  if (!account) return null;
  const value = account as Record<string, unknown>;
  return {
    type: typeof value.type === "string" ? value.type : "unknown",
    email: typeof value.email === "string" ? value.email : null,
    planType: typeof value.planType === "string" ? value.planType : null
  };
}

async function authPrincipalFingerprint(
  path: string,
  account: CodexAuthAccount | null,
  requiresOpenaiAuth: boolean
): Promise<string | null> {
  const content = await readFile(path).catch(() => null);
  if (content) {
    try {
      const parsed = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
      const authMode = typeof parsed.auth_mode === "string" ? parsed.auth_mode : "unknown";
      const tokens = parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
        ? parsed.tokens as Record<string, unknown>
        : null;
      const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : null;
      if (accountId) return fingerprint(["chatgpt", authMode, accountId]);
      const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
      if (apiKey) return fingerprint(["api_key", authMode, fingerprint([apiKey])]);
    } catch {
      // Fall back to the normalized account identity below. Invalid files are
      // still surfaced by account/read rather than treated as a token change.
    }
  }
  if (account) return fingerprint(["account", account.type, account.email ?? ""]);
  return requiresOpenaiAuth ? null : fingerprint(["authentication_not_required"]);
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function removeOwnedPath(dataDir: string, candidate: string): Promise<void> {
  const root = resolve(dataDir);
  const target = resolve(candidate);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to remove authentication data outside muxpilot's data directory: ${target}`);
  }
  const entry = await lstat(target).catch(() => null);
  if (!entry) return;
  if (entry.isSymbolicLink()) {
    await rm(target, { force: true });
    return;
  }
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (realTarget === realRoot || !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`Refusing to follow an authentication-data symlink outside muxpilot's data directory: ${target}`);
  }
  await rm(target, { recursive: entry.isDirectory(), force: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationError(message: string): boolean {
  return /unauthori[sz]ed|authentication|required|access token|refresh token|logged out|signed in/i.test(message);
}

function cliRecoveryMessage(message: string): string {
  return `${message} Manage Codex authentication with the Codex CLI, then return to muxpilot.`;
}

function sanitizeError(message: string): string {
  return message
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[credential redacted]")
    .replace(/(?:sk-|sess-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .slice(0, 1_000);
}
