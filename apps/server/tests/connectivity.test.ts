import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/config.js";
import { buildConnectivity, buildRemoteAccess } from "../src/services/connectivity.js";

describe("buildConnectivity", () => {
  it("returns LAN phone URLs when the app is bound to all interfaces", () => {
    const response = buildConnectivity(testConfig({ host: "0.0.0.0", lanEnabled: true, operatorToken: "correct-access-key" }), [
      "192.168.1.25",
      "10.0.0.8"
    ]);

    expect(response.phoneAccessAvailable).toBe(true);
    expect(response.primaryUrl).toBe("http://192.168.1.25:5177");
    expect(response.urls).toEqual(["http://192.168.1.25:5177", "http://10.0.0.8:5177"]);
  });

  it("returns HTTPS LAN phone URLs when the web protocol is HTTPS", () => {
    const response = buildConnectivity(testConfig({ host: "0.0.0.0", lanEnabled: true, webProtocol: "https" }), ["192.168.1.25"]);

    expect(response.webProtocol).toBe("https");
    expect(response.primaryUrl).toBe("https://192.168.1.25:5177");
    expect(response.urls).toEqual(["https://192.168.1.25:5177"]);
  });

  it("prefers reachable LAN addresses over Docker bridge addresses", () => {
    const response = buildConnectivity(testConfig({ host: "0.0.0.0", lanEnabled: true, operatorToken: "correct-access-key", webPort: 12778 }), [
      "172.18.0.1",
      "192.168.1.174"
    ]);

    expect(response.primaryUrl).toBe("http://192.168.1.174:12778");
    expect(response.urls).toEqual(["http://192.168.1.174:12778", "http://172.18.0.1:12778"]);
  });

  it("reports loopback binds as unavailable for phone access", () => {
    const response = buildConnectivity(testConfig({ host: "127.0.0.1" }), ["192.168.1.25"]);

    expect(response.phoneAccessAvailable).toBe(false);
    expect(response.primaryUrl).toBeNull();
    expect(response.warnings[0]).toContain("bound to loopback");
    expect(response.warnings[0]).toContain("MUXPILOT_LAN_ENABLED=1");
  });

  it("returns keyed remote access URLs for host-only sharing", () => {
    const response = buildRemoteAccess(testConfig({ host: "0.0.0.0", lanEnabled: true }), "river-slate-42-orbit-copper-17", [
      "192.168.1.25"
    ]);

    expect(response.accessKey).toBe("river-slate-42-orbit-copper-17");
    expect(response.primaryAccessUrl).toBe("http://192.168.1.25:5177/access?accessKey=river-slate-42-orbit-copper-17");
    expect(response.accessUrls).toEqual(["http://192.168.1.25:5177/access?accessKey=river-slate-42-orbit-copper-17"]);
    expect(response.pwaTrust.available).toBe(false);
  });

  it("returns plain remote access URLs when unrestricted remote access is enabled", () => {
    const response = buildRemoteAccess(
      testConfig({ host: "0.0.0.0", lanEnabled: true }),
      "river-slate-42-orbit-copper-17",
      ["192.168.1.25"],
      true
    );

    expect(response.accessMode).toBe("unrestricted");
    expect(response.accessKeyRequired).toBe(false);
    expect(response.unrestrictedRemoteAccess).toBe(true);
    expect(response.primaryAccessUrl).toBe("http://192.168.1.25:5177");
    expect(response.accessUrls).toEqual(["http://192.168.1.25:5177"]);
  });

  it("returns PWA trust URLs when trust files are configured", () => {
    const response = buildRemoteAccess(
      testConfig({ host: "0.0.0.0", lanEnabled: true, pwaTrustDir: "/tmp/muxpilot-trust", pwaTrustPort: 12880 }),
      "river-slate-42-orbit-copper-17",
      ["192.168.1.25", "10.0.0.8"]
    );

    expect(response.pwaTrust).toEqual({
      available: true,
      port: 12880,
      primaryUrl: "http://192.168.1.25:12880/muxpilot-root-ca.crt",
      urls: ["http://192.168.1.25:12880/muxpilot-root-ca.crt", "http://10.0.0.8:12880/muxpilot-root-ca.crt"],
      warnings: []
    });
  });

  it("returns keyed HTTPS remote access URLs", () => {
    const response = buildRemoteAccess(
      testConfig({ host: "0.0.0.0", lanEnabled: true, webProtocol: "https" }),
      "river-slate-42-orbit-copper-17",
      ["192.168.1.25"]
    );

    expect(response.primaryAccessUrl).toBe("https://192.168.1.25:5177/access?accessKey=river-slate-42-orbit-copper-17");
    expect(response.accessUrls).toEqual(["https://192.168.1.25:5177/access?accessKey=river-slate-42-orbit-copper-17"]);
  });
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    lanEnabled: false,
    port: 4177,
    webProtocol: "http",
    webPort: 5177,
    pwaTrustPort: 12880,
    pwaTrustDir: undefined,
    dataDir: "/tmp/muxpilot-test",
    dbPath: "/tmp/muxpilot-test/test.db",
    codexHome: "/tmp/muxpilot-test/.codex",
    sessionSecret: "test-secret-at-least-16-chars",
    operatorToken: "test-access-key",
    corsOrigins: [],
    logLevel: "silent",
    discoveryIntervalMs: 3000,
    parserIntervalMs: 1000,
    openaiApiKey: undefined,
    summaryModel: "gpt-4.1-mini",
    summaryIntervalMs: 10_000,
    summaryDebounceMs: 0,
    openaiPricingJson: undefined,
    inputSubmitKeys: ["Enter"],
    inputModeCycleKeys: ["BTab"],
    approvalKeys: {
      approveOnce: ["Enter"],
      approveForPrefix: ["Down", "Enter"],
      deny: ["Escape"]
    },
    ...overrides
  };
}
