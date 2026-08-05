import { describe, expect, it } from "vitest";
import { bundleBuildId, renderServiceWorker, type PwaBuildBundle } from "../pwaPlugin.js";

describe("PWA build fingerprint", () => {
  it("is stable for identical output and changes with generated UI content", () => {
    const first = bundle({ "assets/index.js": "const version = 1;", "assets/index.css": "body{}" });
    const reordered = bundle({ "assets/index.css": "body{}", "assets/index.js": "const version = 1;" });
    const changed = bundle({ "assets/index.js": "const version = 2;", "assets/index.css": "body{}" });

    expect(bundleBuildId(first)).toBe(bundleBuildId(reordered));
    expect(bundleBuildId(changed)).not.toBe(bundleBuildId(first));
  });

  it("replaces exactly one build token", () => {
    expect(renderServiceWorker('const build = "__MUXPILOT_BUILD_ID__";', "abc123"))
      .toBe('const build = "abc123";');
    expect(() => renderServiceWorker("const build = 'fixed';", "abc123")).toThrow("Expected exactly one");
  });
});

function bundle(files: Record<string, string>): PwaBuildBundle {
  return Object.fromEntries(Object.entries(files).map(([fileName, source]) => [fileName, {
    type: "asset",
    fileName,
    source
  }]));
}
