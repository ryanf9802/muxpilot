import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerRoutes } from "../src/api/routes.js";
import { CodexAuthUnavailableError } from "../src/services/codexAuthLifecycle.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("authentication route errors", () => {
  it("returns the actionable authentication error when session creation is unavailable", async () => {
    const app = Fastify();
    apps.push(app);
    registerRoutes(
      app,
      {
        createSession: async () => {
          throw new CodexAuthUnavailableError("Sign in with the Codex CLI, then return to muxpilot.");
        }
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { requireAccess: async () => undefined, requireLocalAccess: async () => undefined } as never
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { cwd: "/repo", name: "new-work", workspace: { mode: "directory" } }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Sign in with the Codex CLI, then return to muxpilot." });
  });
});
