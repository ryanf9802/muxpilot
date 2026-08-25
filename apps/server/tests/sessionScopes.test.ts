import { describe, expect, it, vi } from "vitest";
import {
  detectSessionScopeCapability,
  isMuxpilotSessionScope,
  sessionScopeName,
  userSystemdEnvironment
} from "../src/services/sessionScopes.js";

describe("session scope capability", () => {
  it("derives an explicit user bus environment", () => {
    expect(userSystemdEnvironment({}, 1000)).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    });
    expect(userSystemdEnvironment({
      XDG_RUNTIME_DIR: "/custom/runtime",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus"
    }, 1000)).toEqual({
      XDG_RUNTIME_DIR: "/custom/runtime",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus"
    });
  });

  it("reports effective availability from the user-systemd probe", async () => {
    const probe = vi.fn(async () => undefined);
    const capability = await detectSessionScopeCapability(true, probe, { XDG_RUNTIME_DIR: "/run/user/1000" });

    expect(probe).toHaveBeenCalledWith({ XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(capability).toEqual({
      configured: true,
      available: true,
      unavailableReason: null,
      environment: { XDG_RUNTIME_DIR: "/run/user/1000" }
    });
  });

  it("distinguishes disabled configuration from an unavailable user manager", async () => {
    const probe = vi.fn(async () => { throw new Error("no bus"); });

    await expect(detectSessionScopeCapability(false, probe, {})).resolves.toMatchObject({
      configured: false,
      available: false,
      unavailableReason: "disabled"
    });
    expect(probe).not.toHaveBeenCalled();
    await expect(detectSessionScopeCapability(true, probe, {})).resolves.toMatchObject({
      configured: true,
      available: false,
      unavailableReason: "user_systemd_unavailable"
    });
  });

  it("accepts only muxpilot-owned capability scope names", () => {
    const scope = sessionScopeName("0123456789abcdef01234567");
    expect(scope).toBe("muxpilot-session-0123456789abcdef01234567.scope");
    expect(isMuxpilotSessionScope(scope)).toBe(true);
    expect(isMuxpilotSessionScope("init.scope")).toBe(false);
    expect(isMuxpilotSessionScope("muxpilot-session-child.scope")).toBe(false);
    expect(isMuxpilotSessionScope(null)).toBe(false);
  });
});
