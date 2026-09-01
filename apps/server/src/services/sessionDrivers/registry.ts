import type { ManagedSession, SessionDriverKind } from "@muxpilot/core";
import type { AgentSessionDriver } from "./types.js";

export class SessionDriverRegistry {
  private readonly drivers = new Map<SessionDriverKind, AgentSessionDriver>();

  constructor(drivers: AgentSessionDriver[] = []) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: AgentSessionDriver): void {
    if (this.drivers.has(driver.kind)) throw new Error(`Session driver is already registered: ${driver.kind}`);
    this.drivers.set(driver.kind, driver);
  }

  has(kind: SessionDriverKind): boolean {
    return this.drivers.has(kind);
  }

  require(kind: SessionDriverKind): AgentSessionDriver {
    const driver = this.drivers.get(kind);
    if (!driver) throw new Error(`Session driver is unavailable: ${kind}`);
    return driver;
  }

  forSession(session: ManagedSession): AgentSessionDriver {
    return this.require(session.driverKind ?? "codex_tmux");
  }
}
