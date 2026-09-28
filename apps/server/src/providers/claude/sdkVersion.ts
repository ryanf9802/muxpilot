import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Installed Claude Agent SDK version; the package does not export its manifest, so read it beside the entry. */
export function claudeAgentSdkVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
