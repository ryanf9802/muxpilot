import { describe, expect, it } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import { SessionDriverRegistry } from "../src/services/sessionDrivers/registry.js";
import type { AgentSessionDriver } from "../src/services/sessionDrivers/types.js";

function driver(kind: AgentSessionDriver["kind"]): AgentSessionDriver {
  return { kind } as AgentSessionDriver;
}

describe("SessionDriverRegistry", () => {
  it("selects the app-server runtime and fails closed when unavailable", () => {
    const appServer = driver("codex_app_server");
    const registry = new SessionDriverRegistry([appServer]);
    expect(registry.forSession({} as ManagedSession)).toBe(appServer);
    expect(() => new SessionDriverRegistry().require()).toThrow("Codex app-server driver is unavailable");
  });

  it("rejects duplicate registrations", () => {
    expect(() => new SessionDriverRegistry([driver("codex_app_server"), driver("codex_app_server")]))
      .toThrow("Codex app-server driver is already registered");
  });
});
