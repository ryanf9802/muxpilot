import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createAccessControl } from "../src/auth/auth.js";
import type { AppConfig } from "../src/config/config.js";

describe("operator access routes", () => {
  it("grants access automatically in trusted local mode", async () => {
    const app = await buildApp(testConfig({ lanEnabled: true, host: "0.0.0.0" }));

    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessGranted: true,
      accessKeyRequired: false,
      accessMode: "local",
      sessionHostMode: "local"
    });
    await app.close();
  });

  it("rejects invalid access keys in token mode", async () => {
    const app = await buildApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" }));

    const response = await app.inject({
      method: "POST",
      url: "/api/access",
      headers: remoteHeaders(),
      payload: { accessKey: "wrong-access-key" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid access key" });
    await app.close();
  });

  it("sets an operator cookie for valid access keys", async () => {
    const app = await buildApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" }));

    const response = await app.inject({
      method: "POST",
      url: "/api/access",
      headers: remoteHeaders(),
      payload: { accessKey: "correct-access-key" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers["set-cookie"]).toEqual(expect.stringContaining("muxpilot_operator="));
    await app.close();
  });

  it("protects routes with the centralized access middleware", async () => {
    const app = await buildApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" }));
    const access = createAccessControl(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" }));
    app.get("/protected", { preHandler: access.requireAccess }, async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders() });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Operator access required" });
    await app.close();
  });

  it("reports that token access is required before a cookie is set", async () => {
    const app = await buildApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" }));

    const response = await app.inject({ method: "GET", url: "/api/me", headers: remoteHeaders() });

    expect(response.json()).toEqual({
      accessGranted: false,
      accessKeyRequired: true,
      accessMode: "token",
      sessionHostMode: "local"
    });
    await app.close();
  });

  it("reports token mode for Vite-proxied remote browsers even when the forwarded host is loopback", async () => {
    const app = await buildApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" }));

    const response = await app.inject({ method: "GET", url: "/api/me", headers: proxiedRemoteLoopbackHostHeaders() });

    expect(response.json()).toEqual({
      accessGranted: false,
      accessKeyRequired: true,
      accessMode: "token",
      sessionHostMode: "local"
    });
    await app.close();
  });

  it("grants remote access without a key when unrestricted remote access is enabled", async () => {
    const app = await buildProtectedApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" }), {
      unrestrictedRemoteAccessEnabled: true
    });

    const me = await app.inject({ method: "GET", url: "/api/me", headers: remoteHeaders() });
    expect(me.json()).toEqual({
      accessGranted: true,
      accessKeyRequired: false,
      accessMode: "unrestricted",
      sessionHostMode: "local"
    });
    expect((await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders() })).statusCode).toBe(200);
    await app.close();
  });

  it("allows host-only routes from loopback and rejects proxied remote browsers", async () => {
    const access = createAccessControl(testConfig({ lanEnabled: true, host: "0.0.0.0" }));
    const app = Fastify();
    await app.register(cookie);
    app.get("/host-only", { preHandler: access.requireLocalAccess }, async () => ({ ok: true }));

    expect((await app.inject({ method: "GET", url: "/host-only" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/host-only", headers: remoteHeaders() })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/host-only", headers: proxiedRemoteLoopbackHostHeaders() })).statusCode).toBe(403);
    await app.close();
  });

  it("revokes existing remote cookies when remote access is rotated", async () => {
    const config = testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" });
    const access = createAccessControl(config);
    const app = Fastify();
    await app.register(cookie);
    access.register(app);
    app.get("/protected", { preHandler: access.requireAccess }, async () => ({ ok: true }));

    const login = await app.inject({
      method: "POST",
      url: "/api/access",
      headers: remoteHeaders(),
      payload: { accessKey: "correct-access-key" }
    });
    const remoteCookie = login.cookies[0]!;

    expect((await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders(), cookies: { [remoteCookie.name]: remoteCookie.value } })).statusCode).toBe(200);

    const nextKey = access.revokeRemoteAccess();

    expect(nextKey).not.toBe("correct-access-key");
    expect((await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders(), cookies: { [remoteCookie.name]: remoteCookie.value } })).statusCode).toBe(401);
    await app.close();
  });

  it("invalidates existing remote cookies when unrestricted remote access is disabled", async () => {
    const config = testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" });
    const access = createAccessControl(config);
    const app = Fastify();
    await app.register(cookie);
    access.register(app);
    app.get("/protected", { preHandler: access.requireAccess }, async () => ({ ok: true }));

    const login = await app.inject({
      method: "POST",
      url: "/api/access",
      headers: remoteHeaders(),
      payload: { accessKey: "correct-access-key" }
    });
    const remoteCookie = login.cookies[0]!;

    access.setUnrestrictedRemoteAccessEnabled(true);
    expect((await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders() })).statusCode).toBe(200);

    access.setUnrestrictedRemoteAccessEnabled(false);
    expect((await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders(), cookies: { [remoteCookie.name]: remoteCookie.value } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders() })).statusCode).toBe(401);
    await app.close();
  });

  it("revokes remote access when an authenticated remote browser logs out", async () => {
    const config = testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" });
    const access = createAccessControl(config);
    const app = Fastify();
    await app.register(cookie);
    access.register(app);
    app.get("/protected", { preHandler: access.requireAccess }, async () => ({ ok: true }));

    const login = await app.inject({
      method: "POST",
      url: "/api/access",
      headers: remoteHeaders(),
      payload: { accessKey: "correct-access-key" }
    });
    const remoteCookie = login.cookies[0]!;

    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: remoteHeaders(),
      cookies: { [remoteCookie.name]: remoteCookie.value }
    });

    expect(logout.statusCode).toBe(200);
    expect(access.currentAccessKey()).not.toBe("correct-access-key");
    expect((await app.inject({ method: "GET", url: "/protected", headers: remoteHeaders(), cookies: { [remoteCookie.name]: remoteCookie.value } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/access", headers: remoteHeaders(), payload: { accessKey: "correct-access-key" } })).statusCode).toBe(401);
    await app.close();
  });

  it("does not revoke remote access for unauthenticated remote logout requests", async () => {
    const config = testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" });
    const access = createAccessControl(config);
    const app = Fastify();
    await app.register(cookie);
    access.register(app);

    const logout = await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: remoteHeaders()
    });

    expect(logout.statusCode).toBe(200);
    expect(access.currentAccessKey()).toBe("correct-access-key");
    expect((await app.inject({ method: "POST", url: "/api/access", headers: remoteHeaders(), payload: { accessKey: "correct-access-key" } })).statusCode).toBe(200);
    await app.close();
  });

  it("does not revoke remote access when the trusted local browser logs out", async () => {
    const config = testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key" });
    const access = createAccessControl(config);
    const app = Fastify();
    await app.register(cookie);
    access.register(app);

    const logout = await app.inject({ method: "POST", url: "/api/logout" });

    expect(logout.statusCode).toBe(200);
    expect(access.currentAccessKey()).toBe("correct-access-key");
    expect((await app.inject({ method: "POST", url: "/api/access", headers: remoteHeaders(), payload: { accessKey: "correct-access-key" } })).statusCode).toBe(200);
    await app.close();
  });

  it("rejects remote cookies signed before a backend restart", async () => {
    const firstApp = await buildProtectedApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "correct-access-key", sessionSecret: "first-secret-at-least-16-chars" }));
    const login = await firstApp.inject({
      method: "POST",
      url: "/api/access",
      headers: remoteHeaders(),
      payload: { accessKey: "correct-access-key" }
    });
    const remoteCookie = login.cookies[0]!;
    expect((await firstApp.inject({ method: "GET", url: "/protected", headers: remoteHeaders(), cookies: { [remoteCookie.name]: remoteCookie.value } })).statusCode).toBe(200);
    await firstApp.close();

    const restartedApp = await buildProtectedApp(testConfig({ lanEnabled: true, host: "0.0.0.0", operatorToken: "next-access-key", sessionSecret: "second-secret-at-least-16-chars" }));
    expect((await restartedApp.inject({ method: "GET", url: "/protected", headers: remoteHeaders(), cookies: { [remoteCookie.name]: remoteCookie.value } })).statusCode).toBe(401);
    await restartedApp.close();
  });
});

async function buildApp(config: AppConfig) {
  const app = Fastify();
  await app.register(cookie);
  createAccessControl(config).register(app);
  return app;
}

async function buildProtectedApp(config: AppConfig, options?: Parameters<typeof createAccessControl>[1]) {
  const app = Fastify();
  await app.register(cookie);
  const access = createAccessControl(config, options);
  access.register(app);
  app.get("/protected", { preHandler: access.requireAccess }, async () => ({ ok: true }));
  return app;
}

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

function remoteHeaders() {
  return {
    "x-muxpilot-client-host": "192.168.1.25:5177",
    "x-muxpilot-client-address": "192.168.1.25"
  };
}

function proxiedRemoteLoopbackHostHeaders() {
  return {
    "x-muxpilot-client-host": "127.0.0.1:5177",
    "x-muxpilot-client-address": "192.168.1.25"
  };
}
