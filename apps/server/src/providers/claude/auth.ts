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
    private readonly run: ClaudeCommandRunner
  ) {
    this.credentialWatch = { directory: configDir, filenames: [".credentials.json", ".claude.json"] };
  }

  async observe(): Promise<ProviderAuthObservation> {
    const status = JSON.parse(await this.run(["auth", "status", "--json"])) as Record<string, unknown>;
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

function fingerprint(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
