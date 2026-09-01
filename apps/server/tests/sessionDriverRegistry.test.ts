import { describe, expect, it } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import { SessionDriverRegistry } from "../src/services/sessionDrivers/registry.js";
import type { AgentSessionDriver } from "../src/services/sessionDrivers/types.js";

function driver(kind: AgentSessionDriver["kind"]): AgentSessionDriver {
  return { kind } as AgentSessionDriver;
}

describe("SessionDriverRegistry", () => {
  it("selects legacy records through the tmux driver", () => {
    const tmux = driver("codex_tmux");
    const registry = new SessionDriverRegistry([tmux]);
    expect(registry.forSession({} as ManagedSession)).toBe(tmux);
  });

  it("selects explicit app-server records and fails closed when unavailable", () => {
    const appServer = driver("codex_app_server");
    const registry = new SessionDriverRegistry([appServer]);
    expect(registry.forSession({ driverKind: "codex_app_server" } as ManagedSession)).toBe(appServer);
    expect(() => registry.require("codex_tmux")).toThrow("Session driver is unavailable: codex_tmux");
  });

  it("rejects duplicate registrations", () => {
    expect(() => new SessionDriverRegistry([driver("codex_tmux"), driver("codex_tmux")]))
      .toThrow("Session driver is already registered: codex_tmux");
  });
});
