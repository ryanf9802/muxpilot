import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import type {
  CodexAuthAccount,
  CodexAuthLogin,
  CodexAuthProfile,
  CodexAuthState,
  StartCodexAuthLoginRequest
} from "@muxpilot/core";
import type { AppDatabase } from "../db/database.js";
import { EventBus } from "./eventBus.js";
import { eventId } from "../utils/ids.js";
import { nowIso } from "../utils/time.js";
import { CodexAppServerClient, type AccountReadResponse, type CodexAppServerMessage } from "./codexUsage.js";

const RECONCILE_INTERVAL_MS = 15_000;
const WATCH_DEBOUNCE_MS = 250;

export interface CodexAuthRuntimeHooks {
  blockers(): Promise<string[]>;
  reconcile(): Promise<string[]>;
  suspend(): Promise<string[]>;
  invalidateConsumers(): void;
  admissionReleased(): void;
}

interface ActiveLogin extends CodexAuthLogin {
  providerLoginId: string | null;
  label: string;
  replaceProfileId: string | null;
  client: CodexAppServerClient;
  directory: string;
  unsubscribe: () => void;
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
  private client: CodexAppServerClient;
  private watcher: FSWatcher | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private hooks: CodexAuthRuntimeHooks | null = null;
  private operation: Promise<void> = Promise.resolve();
  private profiles: CodexAuthProfile[] = [];
  private logins = new Map<string, ActiveLogin>();
  private pendingProfileId: string | null = null;
  private pendingLogout = false;
  private pendingExternalReconcile = false;
  private lastAuthDigest: string | null = null;
  private stateValue: CodexAuthState;

  constructor(
    private readonly db: AppDatabase,
    private readonly events: EventBus,
    private readonly codexHome: string,
    dataDir: string,
    private readonly logger?: Pick<Logger, "warn" | "debug">
  ) {
    this.authPath = join(codexHome, "auth.json");
    this.profileRoot = join(dataDir, "private", "codex-auth-profiles");
    this.loginRoot = join(dataDir, "runtime", "codex-auth-logins");
    this.client = this.newClient(codexHome);
    this.stateValue = {
      status: "checking",
      account: null,
      activeProfileId: null,
      profiles: [],
      revision: 0,
      observedAt: nowIso(),
      error: null,
      admissionHeld: true,
      pendingSessionIds: [],
      credentialStorage: "file"
    };
  }

  async start(): Promise<void> {
    await Promise.all([
      mkdir(this.profileRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.loginRoot, { recursive: true, mode: 0o700 })
    ]);
    await Promise.all([chmod(this.profileRoot, 0o700), chmod(this.loginRoot, 0o700)]);
    this.profiles = await this.db.getCodexAuthProfiles();
    const fileCredentials = await this.fileCredentialsSupported();
    if (!fileCredentials) this.update({ credentialStorage: "unsupported" });
    await this.refreshAccount("startup");
    if (fileCredentials) {
      this.watcher = watch(dirname(this.authPath), { persistent: false }, (_event, filename) => {
        if (filename?.toString() !== "auth.json") return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.serialize(async () => {
            const digest = await fileDigest(this.authPath);
            if (digest === this.lastAuthDigest) return;
            this.pendingExternalReconcile = true;
            await this.reconcilePending("external credential change");
          });
        }, WATCH_DEBOUNCE_MS);
      });
    }
    this.interval = setInterval(() => void this.serialize(async () => {
      if (this.stateValue.credentialStorage === "unsupported") {
        const previous = this.stateValue.account;
        await this.refreshAccount("periodic reconciliation", true, false);
        if (!accountsEqual(previous, this.stateValue.account)) await this.reconcileRuntimes();
        return;
      }
      await this.reconcilePending("periodic reconciliation");
    }), RECONCILE_INTERVAL_MS);
  }

  setRuntimeHooks(hooks: CodexAuthRuntimeHooks): void {
    this.hooks = hooks;
  }

  state(): CodexAuthState {
    return { ...this.stateValue, profiles: this.profiles.map((profile) => ({ ...profile, account: { ...profile.account } })) };
  }

  assertReady(): void {
    if (this.stateValue.status !== "ready" || this.stateValue.admissionHeld) {
      throw new CodexAuthUnavailableError(this.stateValue.error ?? "Codex authentication is being reconciled. Try again when the account is ready.");
    }
  }

  async refresh(): Promise<CodexAuthState> {
    await this.serialize(() => this.refreshAccount("manual refresh"));
    return this.state();
  }

  async reconcileAfterStartup(): Promise<void> {
    this.update({ admissionHeld: true });
    if (this.stateValue.status !== "ready") {
      const pending = this.stateValue.status === "signed_out" || this.stateValue.status === "authentication_required"
        ? await this.hooks?.suspend() ?? []
        : await this.hooks?.blockers() ?? [];
      this.update({ admissionHeld: true, pendingSessionIds: pending });
      return;
    }
    this.pendingExternalReconcile = true;
    await this.serialize(() => this.reconcilePending("startup authentication reconciliation"));
  }

  async startLogin(input: StartCodexAuthLoginRequest): Promise<CodexAuthLogin> {
    if (this.stateValue.credentialStorage !== "file") throw new CodexAuthUnavailableError("Saved Codex accounts are unavailable with the configured credential store.");
    const id = randomUUID();
    const directory = join(this.loginRoot, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.writeStagingConfig(directory);
    const client = this.newClient(directory);
    const login: ActiveLogin = {
      id,
      status: "pending",
      verificationUrl: null,
      userCode: null,
      profile: null,
      error: null,
      providerLoginId: null,
      label: input.label.trim(),
      replaceProfileId: input.replaceProfileId ?? null,
      client,
      directory,
      unsubscribe: () => undefined
    };
    login.unsubscribe = client.subscribe((message) => this.handleLoginMessage(login, message));
    this.logins.set(id, login);
    try {
      const response = await client.request<Record<string, unknown>>("account/login/start", { type: "chatgptDeviceCode" });
      login.providerLoginId = stringValue(response.loginId);
      login.verificationUrl = stringValue(response.verificationUrl);
      login.userCode = stringValue(response.userCode);
      if (!this.stateValue.account) this.update({ status: "signing_in" });
    } catch (error) {
      this.failLogin(login, error);
    }
    return publicLogin(login);
  }

  login(id: string): CodexAuthLogin | null {
    const login = this.logins.get(id);
    return login ? publicLogin(login) : null;
  }

  async cancelLogin(id: string): Promise<void> {
    const login = this.logins.get(id);
    if (!login) return;
    login.status = "cancelled";
    if (login.providerLoginId) {
      await login.client.request("account/login/cancel", { loginId: login.providerLoginId }).catch(() => undefined);
    }
    login.unsubscribe();
    login.client.stop();
    await rm(login.directory, { recursive: true, force: true });
    if (![...this.logins.values()].some((candidate) => candidate.status === "pending")) {
      await this.refreshAccount("login cancelled");
    }
  }

  async renameProfile(id: string, label: string): Promise<CodexAuthState> {
    const profile = this.requireProfile(id);
    profile.label = label.trim();
    profile.updatedAt = nowIso();
    await this.persistProfiles();
    this.update({ profiles: this.profiles });
    return this.state();
  }

  async activateProfile(id: string): Promise<CodexAuthState> {
    if (this.pendingProfileId || this.pendingLogout || this.stateValue.status === "switching") {
      throw new CodexAuthUnavailableError("Another Codex account change is already in progress.", 409);
    }
    const profile = this.requireProfile(id);
    if (profile.requiresReauthentication) throw new CodexAuthUnavailableError("This saved account must be authenticated again before it can be activated.");
    this.pendingProfileId = id;
    this.update({ status: "switching", admissionHeld: true, error: null });
    await this.serialize(() => this.reconcilePending("profile switch"));
    return this.state();
  }

  async forgetProfile(id: string): Promise<CodexAuthState> {
    this.requireProfile(id);
    this.profiles = this.profiles.filter((profile) => profile.id !== id);
    await this.persistProfiles();
    await rm(join(this.profileRoot, id), { recursive: true, force: true });
    this.update({ activeProfileId: this.stateValue.activeProfileId === id ? null : this.stateValue.activeProfileId });
    return this.state();
  }

  async logout(): Promise<CodexAuthState> {
    if (this.pendingProfileId || this.pendingLogout || this.stateValue.status === "switching") {
      throw new CodexAuthUnavailableError("Another Codex account change is already in progress.", 409);
    }
    this.pendingLogout = true;
    this.update({ status: "switching", admissionHeld: true, error: null });
    await this.serialize(() => this.reconcilePending("sign out"));
    return this.state();
  }

  async stop(): Promise<void> {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.interval) clearInterval(this.interval);
    this.watcher?.close();
    this.client.stop();
    for (const login of this.logins.values()) {
      login.unsubscribe();
      login.client.stop();
      await rm(login.directory, { recursive: true, force: true });
    }
  }

  reportAuthenticationFailure(error: unknown): void {
    const message = sanitizeError(errorMessage(error));
    if (!isAuthenticationError(message)) return;
    this.pendingExternalReconcile = true;
    this.update({ status: "authentication_required", admissionHeld: true, error: message });
    void this.serialize(() => this.reconcilePending("runtime authentication failure"));
  }

  reportAccountUpdated(): void {
    this.update({ status: "checking", admissionHeld: true, error: null });
    void this.serialize(() => this.reconcileAccountNotification());
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.catch(() => undefined).then(operation);
    this.operation = next.catch((error) => {
      this.logger?.warn({ err: error }, "Codex authentication reconciliation failed");
    });
    return next;
  }

  private async reconcilePending(reason: string): Promise<void> {
    if (this.pendingLogout) {
      const blockers = await this.hooks?.blockers() ?? [];
      if (blockers.length > 0) {
        this.update({ status: "switching", admissionHeld: true, pendingSessionIds: blockers, error: "Waiting for active sessions to reach a safe boundary before signing out." });
        return;
      }
      await this.client.request("account/logout");
      this.client.stop();
      this.hooks?.invalidateConsumers();
      await this.hooks?.suspend();
      this.pendingLogout = false;
      await this.refreshAccount(reason);
      return;
    }
    if (this.pendingProfileId) {
      const blockers = await this.hooks?.blockers() ?? [];
      if (blockers.length > 0) {
        this.update({ status: "switching", admissionHeld: true, pendingSessionIds: blockers, error: "Waiting for active sessions to reach a safe boundary." });
        return;
      }
      const profile = this.requireProfile(this.pendingProfileId);
      const outgoingProfileId = this.stateValue.activeProfileId;
      await this.captureActiveProfile();
      await replaceFile(join(this.profileRoot, profile.id, "auth.json"), this.authPath);
      this.update({ activeProfileId: profile.id });
      this.hooks?.invalidateConsumers();
      this.pendingProfileId = null;
      this.pendingExternalReconcile = false;
      await this.refreshAccount(reason, false);
      if (this.stateValue.status !== "ready") {
        const outgoingPath = outgoingProfileId ? join(this.profileRoot, outgoingProfileId, "auth.json") : null;
        if (outgoingPath && outgoingProfileId !== profile.id && await exists(outgoingPath)) {
          await replaceFile(outgoingPath, this.authPath);
          this.update({ activeProfileId: outgoingProfileId });
          this.hooks?.invalidateConsumers();
          await this.refreshAccount("restore account after failed switch");
          if (this.state().status === "ready") this.pendingExternalReconcile = false;
        }
        return;
      }
      await this.reconcileRuntimes();
      return;
    }
    if (!this.pendingExternalReconcile) return;
    this.update({ status: "checking", admissionHeld: true, error: null });
    this.hooks?.invalidateConsumers();
    await this.refreshAccount(reason, false);
    const blockers = await this.hooks?.blockers() ?? [];
    const pending = await this.reconcileRuntimes();
    const remaining = [...new Set([...blockers, ...pending])];
    this.pendingExternalReconcile = remaining.length > 0;
    this.update({
      admissionHeld: remaining.length > 0,
      pendingSessionIds: remaining,
      error: remaining.length > 0 ? "Waiting for active sessions to reach a safe boundary." : this.stateValue.error
    });
  }

  private async reconcileAccountNotification(): Promise<void> {
    const previousAccount = this.stateValue.account;
    const previousDigest = this.lastAuthDigest;
    await this.refreshAccount("Codex account update notification", false);
    if (accountsEqual(previousAccount, this.stateValue.account) && previousDigest === this.lastAuthDigest) {
      this.update({ admissionHeld: false, pendingSessionIds: [], error: null });
      this.hooks?.admissionReleased();
      return;
    }
    if (this.stateValue.status !== "ready") {
      const pending = this.stateValue.status === "signed_out" || this.stateValue.status === "authentication_required"
        ? await this.hooks?.suspend() ?? []
        : await this.hooks?.blockers() ?? [];
      this.update({ admissionHeld: true, pendingSessionIds: pending });
      return;
    }
    this.pendingExternalReconcile = true;
    await this.reconcileRuntimes();
    this.pendingExternalReconcile = this.stateValue.pendingSessionIds.length > 0;
  }

  private async reconcileRuntimes(): Promise<string[]> {
    const pending = await this.hooks?.reconcile() ?? [];
    this.update({
      pendingSessionIds: pending,
      admissionHeld: pending.length > 0 || this.stateValue.status !== "ready",
      error: pending.length > 0 ? "Waiting for active sessions to reach a safe boundary." : this.stateValue.error
    });
    if (pending.length === 0 && this.stateValue.status === "ready") this.hooks?.admissionReleased();
    return pending;
  }

  private async refreshAccount(reason: string, releaseAdmission = true, forceTokenRefresh = true): Promise<void> {
    const previousProfileId = this.stateValue.activeProfileId;
    this.client.stop(new Error(`Codex authentication client refreshed: ${reason}`));
    try {
      const response = await this.client.request<AccountReadResponse>("account/read", { refreshToken: forceTokenRefresh });
      const account = normalizeAccount(response.account);
      let activeProfileId = await this.matchActiveProfile();
      const previous = previousProfileId ? this.profiles.find((profile) => profile.id === previousProfileId) : null;
      if (!activeProfileId && previous && account && sameAccount(previous.account, account) && await exists(this.authPath)) {
        await replaceFile(this.authPath, join(this.profileRoot, previous.id, "auth.json"));
        previous.updatedAt = nowIso();
        previous.requiresReauthentication = false;
        await this.persistProfiles();
        activeProfileId = previous.id;
      }
      this.lastAuthDigest = await fileDigest(this.authPath);
      this.update({
        status: account || !response.requiresOpenaiAuth ? "ready" : "signed_out",
        account,
        activeProfileId,
        admissionHeld: releaseAdmission ? false : true,
        pendingSessionIds: [],
        error: account || !response.requiresOpenaiAuth ? null : "Codex account authentication required."
      });
    } catch (error) {
      const message = errorMessage(error);
      this.pendingExternalReconcile = true;
      const active = previousProfileId ? this.profiles.find((profile) => profile.id === previousProfileId) : null;
      if (active && isAuthenticationError(message)) {
        active.requiresReauthentication = true;
        active.updatedAt = nowIso();
        await this.persistProfiles();
      }
      this.update({
        status: isAuthenticationError(message) ? "authentication_required" : "temporarily_unavailable",
        account: null,
        admissionHeld: true,
        error: sanitizeError(message)
      });
    }
  }

  private async handleLoginMessage(login: ActiveLogin, message: CodexAppServerMessage): Promise<void> {
    if (message.method !== "account/login/completed" || login.status !== "pending") return;
    const params = recordValue(message.params);
    if (login.providerLoginId && params?.loginId !== login.providerLoginId) return;
    if (params?.success !== true) {
      this.failLogin(login, new Error(stringValue(params?.error) ?? "Codex login failed."));
      return;
    }
    try {
      const response = await login.client.request<AccountReadResponse>("account/read", { refreshToken: true });
      const account = normalizeAccount(response.account);
      if (!account) throw new Error("Codex login completed without an account.");
      const authFile = join(login.directory, "auth.json");
      await stat(authFile);
      const now = nowIso();
      const existing = login.replaceProfileId ? this.profiles.find((profile) => profile.id === login.replaceProfileId) : null;
      const profile: CodexAuthProfile = {
        id: existing?.id ?? randomUUID(),
        label: login.label,
        account,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        requiresReauthentication: false
      };
      await mkdir(join(this.profileRoot, profile.id), { recursive: true, mode: 0o700 });
      await replaceFile(authFile, join(this.profileRoot, profile.id, "auth.json"));
      this.profiles = [...this.profiles.filter((candidate) => candidate.id !== profile.id), profile]
        .sort((left, right) => left.label.localeCompare(right.label));
      await this.persistProfiles();
      login.status = "completed";
      login.profile = profile;
      login.unsubscribe();
      login.client.stop();
      await rm(login.directory, { recursive: true, force: true });
      this.update({ profiles: this.profiles, status: this.stateValue.account ? "ready" : "signed_out" });
    } catch (error) {
      this.failLogin(login, error);
    }
  }

  private failLogin(login: ActiveLogin, error: unknown): void {
    login.status = "failed";
    login.error = sanitizeError(errorMessage(error));
    login.unsubscribe();
    login.client.stop();
    void rm(login.directory, { recursive: true, force: true });
    this.update({ status: this.stateValue.account ? "ready" : "authentication_required", error: login.error });
  }

  private async captureActiveProfile(): Promise<void> {
    const activeId = this.stateValue.activeProfileId;
    if (!activeId || !await exists(this.authPath)) return;
    const profile = this.profiles.find((candidate) => candidate.id === activeId);
    if (!profile) return;
    await mkdir(join(this.profileRoot, activeId), { recursive: true, mode: 0o700 });
    await replaceFile(this.authPath, join(this.profileRoot, activeId, "auth.json"));
    profile.updatedAt = nowIso();
    await this.persistProfiles();
  }

  private async matchActiveProfile(): Promise<string | null> {
    const current = await fileDigest(this.authPath);
    if (!current) return null;
    for (const profile of this.profiles) {
      if (await fileDigest(join(this.profileRoot, profile.id, "auth.json")) === current) return profile.id;
    }
    return null;
  }

  private async persistProfiles(): Promise<void> {
    await this.db.setCodexAuthProfiles(this.profiles, nowIso());
  }

  private requireProfile(id: string): CodexAuthProfile {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new CodexAuthUnavailableError("Saved Codex account not found.");
    return profile;
  }

  private update(changes: Partial<CodexAuthState>): void {
    this.stateValue = {
      ...this.stateValue,
      ...changes,
      profiles: this.profiles,
      revision: this.stateValue.revision + 1,
      observedAt: nowIso()
    };
    this.events.publish({ id: eventId(), type: "codex.auth.updated", sessionId: "__app__", payload: this.state(), timestamp: this.stateValue.observedAt });
  }

  private newClient(codexHome: string): CodexAppServerClient {
    return new CodexAppServerClient({ codexHome, timeoutMs: 15_000, logger: this.logger });
  }

  private async fileCredentialsSupported(): Promise<boolean> {
    const config = await readFile(join(this.codexHome, "config.toml"), "utf8").catch(() => "");
    const setting = config.match(/^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m)?.[1];
    if (setting === "keyring" || setting === "ephemeral") return false;
    if (setting === "auto") return exists(this.authPath);
    return !setting || setting === "file";
  }

  private async writeStagingConfig(directory: string): Promise<void> {
    const source = await readFile(join(this.codexHome, "config.toml"), "utf8").catch(() => "");
    const setting = /^\s*cli_auth_credentials_store\s*=.*$/m;
    const config = setting.test(source)
      ? source.replace(setting, 'cli_auth_credentials_store = "file"')
      : `${source.trimEnd()}\ncli_auth_credentials_store = "file"\n`;
    await writeFile(join(directory, "config.toml"), config, { encoding: "utf8", mode: 0o600 });
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

function sameAccount(left: CodexAuthAccount, right: CodexAuthAccount): boolean {
  return left.type === right.type && left.email === right.email;
}

function accountsEqual(left: CodexAuthAccount | null, right: CodexAuthAccount | null): boolean {
  return left === right || Boolean(left && right && sameAccount(left, right) && left.planType === right.planType);
}

function publicLogin(login: ActiveLogin): CodexAuthLogin {
  return {
    id: login.id,
    status: login.status,
    verificationUrl: login.verificationUrl,
    userCode: login.userCode,
    profile: login.profile,
    error: login.error
  };
}

async function replaceFile(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, temporary);
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

async function fileDigest(path: string): Promise<string | null> {
  const content = await readFile(path).catch(() => null);
  return content ? createHash("sha256").update(content).digest("hex") : null;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationError(message: string): boolean {
  return /unauthori[sz]ed|authentication|required|access token|refresh token|logged out|signed in/i.test(message);
}

function sanitizeError(message: string): string {
  return message
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[credential redacted]")
    .replace(/(?:sk-|sess-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .slice(0, 1_000);
}
