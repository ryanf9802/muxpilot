import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "../src/api/routes.js";
import { ProviderAuthUnavailableError } from "../src/providers/shared/authLifecycle.js";
import { testProvider, testProviders } from "./helpers/providers.js";
import { ProviderRegistry } from "../src/providers/registry.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("authentication route errors", () => {
  it("returns the actionable authentication error when session creation is unavailable", async () => {
    const app = Fastify();
    apps.push(app);
    registerRoutes(app, {
      manager: {
        createSession: async () => {
          throw new ProviderAuthUnavailableError("Sign in with the Codex CLI, then return to muxpilot.");
        }
      } as never,
      events: {} as never,
      db: {} as never,
      config: {} as never,
      access: { requireAccess: async () => undefined, requireLocalAccess: async () => undefined } as never,
      providers: testProviders({})
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { cwd: "/repo", name: "new-work", workspace: { mode: "directory" } }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Sign in with the Codex CLI, then return to muxpilot." });
  });
});

describe("provider routes", () => {
  function providerApp() {
    const app = Fastify();
    apps.push(app);
    const setDefaultAgentProvider = vi.fn(async () => undefined);
    const providers = new ProviderRegistry([testProvider("codex", {}), testProvider("claude", null)], "codex");
    registerRoutes(app, {
      manager: {} as never,
      events: {} as never,
      db: { setDefaultAgentProvider } as never,
      config: {} as never,
      access: { requireAccess: async () => undefined, requireLocalAccess: async () => undefined } as never,
      providers
    });
    return { app, providers, setDefaultAgentProvider };
  }

  it("describes every enabled provider with auth, compatibility and capabilities", async () => {
    const { app } = providerApp();
    const response = await app.inject({ method: "GET", url: "/api/providers" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      defaultProvider: "codex",
      providers: [
        { kind: "codex", displayName: "Codex", loginCommand: "codex login", skillInvocation: { prefix: "$" }, auth: { provider: "codex", status: "ready" } },
        { kind: "claude", displayName: "Claude", loginCommand: "claude auth login", compatibility: { available: false } }
      ]
    });
  });

  it("persists the default provider and rejects unknown providers", async () => {
    const { app, providers, setDefaultAgentProvider } = providerApp();
    const updated = await app.inject({ method: "PATCH", url: "/api/providers/default", payload: { provider: "claude" } });
    expect(updated.statusCode).toBe(200);
    expect(providers.defaultProvider()).toBe("claude");
    expect(setDefaultAgentProvider).toHaveBeenCalledWith("claude", expect.any(String));
    expect((await app.inject({ method: "GET", url: "/api/providers/gemini/auth" })).statusCode).toBe(404);
  });

  it("returns 404 for usage capabilities a provider does not implement", async () => {
    const { app } = providerApp();
    const history = await app.inject({ method: "GET", url: "/api/providers/claude/usage/history?days=7" });
    expect(history.statusCode).toBe(404);
    const reset = await app.inject({ method: "POST", url: "/api/providers/codex/usage/reset", payload: { idempotencyKey: "key" } });
    expect(reset.statusCode).toBe(404);
    const summary = await app.inject({ method: "GET", url: "/api/providers/claude/usage/summary" });
    expect(summary.json()).toMatchObject({ provider: "claude", limits: [] });
  });
});
