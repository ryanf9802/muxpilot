import { createHash, scryptSync } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Logger } from "pino";
import type { ProviderAuthAccount } from "@muxpilot/core";
import type { AppDatabase } from "../../db/database.js";
import type { EventBus } from "../../services/eventBus.js";
import {
  ProviderAuthLifecycle,
  ProviderAuthUnavailableError,
  sanitizeCredentialText,
  errorMessage,
  type ProviderAuthDatabase,
  type ProviderAuthLifecycleOptions,
  type ProviderAuthObservation,
  type ProviderAuthObserver,
  type ProviderAuthRuntimeHooks
} from "../shared/authLifecycle.js";
import { CodexAppServerClient, type AccountReadResponse } from "./usage.js";

type AuthClient = Pick<CodexAppServerClient, "request" | "stop">;
type CodexAuthDatabase = ProviderAuthDatabase & Pick<AppDatabase, "clearCodexAuthProfiles">;

export type CodexAuthRuntimeHooks = ProviderAuthRuntimeHooks;
export { ProviderAuthUnavailableError as CodexAuthUnavailableError };

export interface CodexAuthLifecycleOptions extends ProviderAuthLifecycleOptions {
  client?: AuthClient;
}

/** Observes the Codex CLI account through `account/read` and the `auth.json` principal. */
export class CodexAuthObserver implements ProviderAuthObserver {
  readonly provider = "codex" as const;
  readonly displayName = "Codex";
  readonly credentialWatch: { directory: string; filenames: string[] };
  private readonly authPath: string;
  private readonly client: AuthClient;

  constructor(
    codexHome: string,
    private readonly db: Pick<AppDatabase, "clearCodexAuthProfiles">,
    private readonly dataDir: string,
    logger?: Pick<Logger, "warn" | "debug">,
    client?: AuthClient
  ) {
    this.authPath = join(codexHome, "auth.json");
    this.credentialWatch = { directory: dirname(this.authPath), filenames: ["auth.json"] };
    this.client = client ?? new CodexAppServerClient({ codexHome, timeoutMs: 15_000, logger });
  }

  async prepare(): Promise<void> {
    await Promise.all([
      removeOwnedPath(this.dataDir, join(this.dataDir, "private", "codex-auth-profiles")),
      removeOwnedPath(this.dataDir, join(this.dataDir, "runtime", "codex-auth-logins")),
      this.db.clearCodexAuthProfiles()
    ]);
  }

  async observe(reason: string): Promise<ProviderAuthObservation> {
    this.client.stop(new Error(`Codex authentication observer refreshed: ${reason}`));
    let account: ProviderAuthAccount | null = null;
    let requiresOpenaiAuth = true;
    let status: ProviderAuthObservation["status"];
    let error: string | null = null;
    try {
      // Codex CLI 0.156 can report a valid ChatGPT login as signed out when this
      // observer forces token refresh. Credential changes are detected separately.
      const response = await this.client.request<AccountReadResponse>("account/read", { refreshToken: false });
      account = normalizeAccount(response.account);
      requiresOpenaiAuth = response.requiresOpenaiAuth;
      status = account || !response.requiresOpenaiAuth ? "ready" : "signed_out";
      if (status === "signed_out") error = "Codex authentication is required. Sign in with the Codex CLI, then return to muxpilot.";
    } catch (cause) {
      const message = sanitizeCredentialText(errorMessage(cause));
      status = this.isAuthenticationError(message) ? "authentication_required" : "temporarily_unavailable";
      error = status === "authentication_required" ? this.recoveryMessage(message) : message;
    }
    return { status, account, error, principal: await authPrincipalFingerprint(this.authPath, account, requiresOpenaiAuth) };
  }

  isAuthenticationError(message: string): boolean {
    return /unauthori[sz]ed|authentication|required|access token|refresh token|logged out|signed in/i.test(message);
  }

  recoveryMessage(message: string): string {
    return `${message} Manage Codex authentication with the Codex CLI, then return to muxpilot.`;
  }

  stop(): void {
    this.client.stop();
  }
}

/** Codex authentication lifecycle; retained as a named type for composition and tests. */
export class CodexAuthLifecycle extends ProviderAuthLifecycle {
  constructor(
    db: CodexAuthDatabase,
    events: Pick<EventBus, "publish">,
    codexHome: string,
    dataDir: string,
    logger?: Pick<Logger, "warn" | "debug">,
    options: CodexAuthLifecycleOptions = {}
  ) {
    super(db, events, new CodexAuthObserver(codexHome, db, dataDir, logger, options.client), logger, options);
  }
}

function normalizeAccount(account: AccountReadResponse["account"]): ProviderAuthAccount | null {
  if (!account) return null;
  const value = account as Record<string, unknown>;
  return {
    type: typeof value.type === "string" ? value.type : "unknown",
    email: typeof value.email === "string" ? value.email : null,
    planType: typeof value.planType === "string" ? value.planType : null
  };
}

export async function authPrincipalFingerprint(
  path: string,
  account: ProviderAuthAccount | null,
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
      if (apiKey) return apiKeyFingerprint(authMode, apiKey);
    } catch {
      // Fall back to the normalized account identity below. Invalid files are
      // still surfaced by account/read rather than treated as a token change.
    }
  }
  if (account) return fingerprint(["account", account.type, account.email ?? ""]);
  return requiresOpenaiAuth ? null : fingerprint(["authentication_not_required"]);
}

/**
 * Identifies an API key without keeping a fast hash of the secret. The fixed salt keeps the principal stable across
 * restarts; the key itself only needs change detection, never verification.
 */
function apiKeyFingerprint(authMode: string, apiKey: string): string {
  return scryptSync(JSON.stringify(["api_key", authMode, apiKey]), "muxpilot-codex-auth-principal-v1", 32).toString("hex");
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
