import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { EventBus } from "../../services/eventBus.js";
import {
  ProviderAuthLifecycle,
  type ProviderAuthDatabase,
  type ProviderAuthLifecycleOptions,
  type ProviderAuthObservation,
  type ProviderAuthObserver
} from "../shared/authLifecycle.js";

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 15_000;
const IDENTITY_RETRY_DELAYS_MS = [250, 750, 1_500];

export type ClaudeCommandRunner = (args: string[]) => Promise<string>;

/**
 * Observes the Claude Code CLI login through `claude auth status --json`. The principal fingerprint is derived
 * from account identity only, so routine OAuth token refreshes never look like an account change.
 */
export class ClaudeAuthObserver implements ProviderAuthObserver {
  readonly provider = "claude" as const;
  readonly displayName = "Claude";
  readonly credentialWatch: { directory: string; filenames: string[] };

  constructor(
    configDir: string,
    private readonly run: ClaudeCommandRunner,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    this.credentialWatch = { directory: configDir, filenames: [".credentials.json", ".claude.json"] };
  }

  async observe(): Promise<ProviderAuthObservation> {
    let status = await this.status();
    // Claude Code rewrites its account file often; a read that races a rewrite reports an OAuth login without
    // its account. Re-read before fingerprinting so a transient gap never looks like an account change.
    for (const delay of IDENTITY_RETRY_DELAYS_MS) {
      if (!missingOAuthIdentity(status)) break;
      await this.sleep(delay);
      status = await this.status();
    }
    if (status.loggedIn !== true) {
      return {
        status: "signed_out",
        account: null,
        principal: null,
        error: "Claude authentication is required. Run `claude auth login` on the muxpilot host, then return to muxpilot."
      };
    }
    const account = {
      type: stringValue(status.authMethod) ?? "unknown",
      email: stringValue(status.email),
      planType: stringValue(status.subscriptionType),
      organization: stringValue(status.orgName)
    };
    return {
      status: "ready",
      account,
      principal: fingerprint([
        account.type,
        stringValue(status.apiProvider) ?? "",
        stringValue(status.orgId) ?? "",
        account.email ?? ""
      ]),
      error: null
    };
  }

  private async status(): Promise<Record<string, unknown>> {
    return JSON.parse(await this.run(["auth", "status", "--json"])) as Record<string, unknown>;
  }

  isAuthenticationError(message: string): boolean {
    return /not logged in|\/login|authentication|oauth|unauthori[sz]ed|invalid api key|token (?:has )?expired|signed out/i.test(message);
  }

  recoveryMessage(message: string): string {
    return `${message} Sign in with \`claude auth login\` on the muxpilot host, then return to muxpilot.`;
  }

  stop(): void {
    // Each observation is a short-lived CLI invocation.
  }
}

export class ClaudeAuthLifecycle extends ProviderAuthLifecycle {
  constructor(
    db: ProviderAuthDatabase,
    events: Pick<EventBus, "publish">,
    configDir: string,
    run: ClaudeCommandRunner,
    logger?: Pick<Logger, "warn" | "debug">,
    options: ProviderAuthLifecycleOptions = {}
  ) {
    super(db, events, new ClaudeAuthObserver(configDir, run), logger, options);
  }
}

/** Runs the Claude CLI with muxpilot's Claude configuration directory and without API-key overrides. */
export function claudeCommandRunner(claudePath: string, environment: Record<string, string | undefined>): ClaudeCommandRunner {
  return async (args) => {
    const { stdout } = await execFileAsync(claudePath, args, {
      env: environment,
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  };
}

function missingOAuthIdentity(status: Record<string, unknown>): boolean {
  return status.loggedIn === true
    && stringValue(status.authMethod) === "claude.ai"
    && !stringValue(status.email)
    && !stringValue(status.orgId);
}

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
