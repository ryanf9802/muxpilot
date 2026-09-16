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

export interface CodexAuthRuntimeHooks {
  blockers(): Promise<string[]>;
  reconcile(): Promise<string[]>;
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
  private changeGeneration = 0;
  private lastObservedGeneration = 0;
  private lastAuthDigest: string | null = null;
  private stateValue: CodexAuthState;

  constructor(
    private readonly db: Pick<AppDatabase, "clearCodexAuthProfiles">,
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
    await this.observeAndReconcile("startup", true, true, true);
    if (this.watchCredentials) {
      this.watcher = watch(dirname(this.authPath), { persistent: false }, (_event, filename) => {
        if (filename?.toString() !== "auth.json") return;
        this.signalExternalChange();
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.serialize(() => this.observeAndReconcile("external credential change", true, true));
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

  assertReady(): void {
    if (this.stateValue.status !== "ready" || this.stateValue.admissionHeld) {
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
    void this.serialize(() => this.observeAndReconcile("runtime authentication failure", true, true));
  }

  reportAccountUpdated(): void {
    this.signalExternalChange();
    void this.serialize(() => this.observeAndReconcile("Codex account update notification", true, true));
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
    knownChange = false,
    deferReconciliation = false
  ): Promise<void> {
    const observedGeneration = this.changeGeneration;
    const previousAccount = this.stateValue.account;
    const previousStatus = this.stateValue.status;
    const previousDigest = this.lastAuthDigest;
    if (knownChange && !this.reconciliationPending) {
      this.update({ admissionHeld: true });
    }

    this.client.stop(new Error(`Codex authentication observer refreshed: ${reason}`));
    let account: CodexAuthAccount | null = null;
    let status: CodexAuthState["status"];
    let error: string | null = null;
    try {
      const response = await this.client.request<AccountReadResponse>("account/read", { refreshToken: forceTokenRefresh });
      account = normalizeAccount(response.account);
      status = account || !response.requiresOpenaiAuth ? "ready" : "signed_out";
      if (status === "signed_out") error = "Codex authentication is required. Sign in with the Codex CLI, then return to muxpilot.";
    } catch (cause) {
      const message = sanitizeError(errorMessage(cause));
      status = isAuthenticationError(message) ? "authentication_required" : "temporarily_unavailable";
      error = status === "authentication_required" ? cliRecoveryMessage(message) : message;
    }
    const digest = await fileDigest(this.authPath);
    this.lastObservedGeneration = observedGeneration;
    const changed = previousDigest !== digest
      || previousStatus !== status
      || !accountsEqual(previousAccount, account);
    this.lastAuthDigest = digest;

    if (!changed && !this.reconciliationPending) {
      if (knownChange) {
        this.update({ admissionHeld: false, pendingSessionIds: [] });
        this.hooks?.admissionReleased();
      } else {
        this.stateValue = { ...this.stateValue, observedAt: nowIso() };
      }
      return;
    }
    if (!this.reconciliationPending) {
      this.reconciliationPending = true;
      this.update({ status: "checking", admissionHeld: true, error: null });
      this.hooks?.invalidateConsumers();
    }
    this.update({ status, account, admissionHeld: true, error });
    if (deferReconciliation) return;
    await this.reconcileObservedState(observedGeneration);
  }

  private async reconcileObservedState(observedGeneration = this.changeGeneration): Promise<void> {
    if (this.stateValue.status === "ready") {
      const pending = await this.hooks?.reconcile() ?? [];
      const newerChangePending = observedGeneration !== this.changeGeneration;
      this.reconciliationPending = pending.length > 0 || newerChangePending;
      this.update({
        admissionHeld: pending.length > 0 || newerChangePending,
        pendingSessionIds: pending,
        error: pending.length > 0 ? "Waiting for active sessions to reach a safe boundary." : null
      });
      if (pending.length === 0 && !newerChangePending) this.hooks?.admissionReleased();
      return;
    }
    const pending = this.stateValue.status === "signed_out" || this.stateValue.status === "authentication_required"
      ? await this.hooks?.suspend() ?? []
      : await this.hooks?.blockers() ?? [];
    this.reconciliationPending = true;
    this.update({ admissionHeld: true, pendingSessionIds: pending });
  }

  private signalExternalChange(): void {
    this.changeGeneration += 1;
    if (!this.stateValue.admissionHeld) {
      this.update({ admissionHeld: true });
      this.hooks?.invalidateConsumers();
    }
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

function accountsEqual(left: CodexAuthAccount | null, right: CodexAuthAccount | null): boolean {
  return left === right || Boolean(left && right
    && left.type === right.type
    && left.email === right.email
    && left.planType === right.planType);
}

async function fileDigest(path: string): Promise<string | null> {
  const content = await readFile(path).catch(() => null);
  return content ? createHash("sha256").update(content).digest("hex") : null;
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
