import { config as loadDotenv } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

loadEnvFiles();

const keySequence = (fallback: string[]) =>
  z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return fallback;
    return value
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }, z.array(z.string().min(1)).min(1));

const booleanFlag = z.preprocess((value) => {
  if (typeof value !== "string") return value ?? false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const schema = z.object({
  lanEnabled: booleanFlag,
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().positive().default(4177),
  webProtocol: z.enum(["http", "https"]).default("http"),
  webPort: z.coerce.number().int().positive().default(5177),
  pwaTrustPort: z.coerce.number().int().positive().default(12880),
  pwaTrustDir: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    z.string().optional()
  ),
  dataDir: z.string().default("./data"),
  dbPath: z.string().default("./data/muxpilot.db"),
  codexHome: z.string().default(join(homedir(), ".codex")),
  sessionSecret: z.string().min(16),
  operatorToken: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    z.string().min(12)
  ),
  corsOrigins: z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }, z.array(z.string().url())),
  logLevel: z.string().default("info"),
  discoveryIntervalMs: z.coerce.number().int().positive().default(1000),
  parserIntervalMs: z.coerce.number().int().positive().default(1000),
  openaiApiKey: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    z.string().optional()
  ),
  summaryModel: z.string().default("gpt-4.1-mini"),
  summaryIntervalMs: z.coerce.number().int().positive().default(10_000),
  summaryDebounceMs: z.coerce.number().int().nonnegative().default(0),
  openaiPricingJson: z.string().optional(),
  inputSubmitKeys: keySequence(["Enter"]),
  inputModeCycleKeys: keySequence(["BTab"]),
  approvalKeys: z.object({
    approveOnce: keySequence(["Enter"]),
    approveForPrefix: keySequence(["Down", "Enter"]),
    deny: keySequence(["Escape"])
  })
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  return parseConfig(process.env, { createDataDir: true });
}

export function parseConfig(env: NodeJS.ProcessEnv, options: { createDataDir?: boolean } = {}): AppConfig {
  const parsed = schema.parse({
    lanEnabled: env.MUXPILOT_LAN_ENABLED,
    host: env.MUXPILOT_HOST ?? defaultHost(env.MUXPILOT_LAN_ENABLED),
    port: env.MUXPILOT_PORT,
    webProtocol: env.MUXPILOT_WEB_PROTOCOL,
    webPort: env.MUXPILOT_WEB_PORT,
    pwaTrustPort: env.MUXPILOT_PWA_TRUST_PORT,
    pwaTrustDir: env.MUXPILOT_PWA_TRUST_DIR,
    dataDir: env.MUXPILOT_DATA_DIR,
    dbPath: env.MUXPILOT_DB_PATH,
    codexHome: env.MUXPILOT_CODEX_HOME,
    sessionSecret: env.MUXPILOT_SESSION_SECRET ?? randomSessionSecret(),
    operatorToken: env.MUXPILOT_OPERATOR_TOKEN ?? randomAccessKey(),
    corsOrigins: env.MUXPILOT_CORS_ORIGINS,
    logLevel: env.MUXPILOT_LOG_LEVEL,
    discoveryIntervalMs: env.MUXPILOT_DISCOVERY_INTERVAL_MS,
    parserIntervalMs: env.MUXPILOT_PARSER_INTERVAL_MS,
    openaiApiKey: env.OPENAI_API_KEY,
    summaryModel: env.MUXPILOT_SUMMARY_MODEL,
    summaryIntervalMs: env.MUXPILOT_SUMMARY_INTERVAL_MS,
    summaryDebounceMs: env.MUXPILOT_SUMMARY_DEBOUNCE_MS,
    openaiPricingJson: env.MUXPILOT_OPENAI_PRICING_JSON,
    inputSubmitKeys: env.MUXPILOT_INPUT_SUBMIT_KEYS,
    inputModeCycleKeys: env.MUXPILOT_INPUT_MODE_CYCLE_KEYS,
    approvalKeys: {
      approveOnce: env.MUXPILOT_APPROVAL_APPROVE_ONCE_KEYS,
      approveForPrefix: env.MUXPILOT_APPROVAL_APPROVE_PREFIX_KEYS,
      deny: env.MUXPILOT_APPROVAL_DENY_KEYS
    }
  });

  const dataDir = resolve(parsed.dataDir);
  if (options.createDataDir) mkdirSync(dataDir, { recursive: true });

  return {
    ...parsed,
    dataDir,
    dbPath: resolve(parsed.dbPath),
    codexHome: resolve(parsed.codexHome),
    pwaTrustDir: parsed.pwaTrustDir ? resolve(parsed.pwaTrustDir) : undefined
  };
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function requiresOperatorToken(config: Pick<AppConfig, "host" | "lanEnabled">): boolean {
  return config.lanEnabled || !isLoopbackBindHost(config.host);
}

function randomSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

const ACCESS_KEY_WORDS = [
  "anchor",
  "basket",
  "copper",
  "delta",
  "ember",
  "forest",
  "garden",
  "harbor",
  "island",
  "jacket",
  "kitten",
  "lantern",
  "meadow",
  "nectar",
  "orange",
  "pepper",
  "quartz",
  "river",
  "silver",
  "timber",
  "umber",
  "velvet",
  "window",
  "yellow",
  "zephyr"
];

export function randomAccessKey(): string {
  const bytes = randomBytes(6);
  return [
    ACCESS_KEY_WORDS[bytes[0]! % ACCESS_KEY_WORDS.length],
    ACCESS_KEY_WORDS[bytes[1]! % ACCESS_KEY_WORDS.length],
    String(10 + (bytes[2]! % 90)),
    ACCESS_KEY_WORDS[bytes[3]! % ACCESS_KEY_WORDS.length],
    ACCESS_KEY_WORDS[bytes[4]! % ACCESS_KEY_WORDS.length],
    String(10 + (bytes[5]! % 90))
  ].join("-");
}

function defaultHost(lanEnabled: string | undefined): string {
  const normalized = lanEnabled?.trim().toLowerCase();
  return normalized && ["1", "true", "yes", "on"].includes(normalized) ? "0.0.0.0" : "127.0.0.1";
}

function loadEnvFiles(): void {
  const envPath = findDotenv(process.cwd(), ".env");
  if (envPath) loadDotenv({ path: envPath });
  const localEnvPath = findDotenv(process.cwd(), ".env.local");
  if (localEnvPath) loadDotenv({ path: localEnvPath, override: true });
}

function findDotenv(start: string, filename: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
