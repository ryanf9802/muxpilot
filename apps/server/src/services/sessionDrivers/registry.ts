import type { ManagedSession } from "@muxpilot/core";
import type { AgentSessionDriver } from "./types.js";

export class SessionDriverRegistry {
  private driver: AgentSessionDriver | null = null;

  constructor(drivers: AgentSessionDriver[] = []) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: AgentSessionDriver): void {
    if (this.driver) throw new Error("Codex app-server driver is already registered");
    this.driver = driver;
  }

  has(_kind: "codex_app_server" = "codex_app_server"): boolean {
    return this.driver !== null;
  }

  require(_kind: "codex_app_server" = "codex_app_server"): AgentSessionDriver {
    if (!this.driver) throw new Error("Codex app-server driver is unavailable");
    return this.driver;
  }

  forSession(_session: ManagedSession): AgentSessionDriver {
    return this.require();
  }
}
