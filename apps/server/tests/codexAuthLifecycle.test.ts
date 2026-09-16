import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAuthLifecycle } from "../src/services/codexAuthLifecycle.js";
import { EventBus } from "../src/services/eventBus.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CodexAuthLifecycle", () => {
  it("removes legacy muxpilot auth data without touching CLI credentials or symlink targets", async () => {
    const fixture = await createFixture();
    const outside = await temporaryDirectory("muxpilot-auth-outside-");
    await writeFile(join(outside, "saved-token"), "preserve");
    await mkdir(join(fixture.dataDir, "private"), { recursive: true });
    await symlink(outside, join(fixture.dataDir, "private", "codex-auth-profiles"));
    await mkdir(join(fixture.dataDir, "runtime", "codex-auth-logins", "pending"), { recursive: true });
    await writeFile(join(fixture.dataDir, "runtime", "codex-auth-logins", "pending", "auth.json"), "legacy");

    await fixture.lifecycle.start();

    expect(fixture.clearProfiles).toHaveBeenCalledOnce();
    await expect(access(join(fixture.dataDir, "private", "codex-auth-profiles"))).rejects.toThrow();
    await expect(access(join(fixture.dataDir, "runtime", "codex-auth-logins"))).rejects.toThrow();
    expect(await readFile(join(outside, "saved-token"), "utf8")).toBe("preserve");
    expect(await readFile(join(fixture.codexHome, "auth.json"), "utf8")).toBe("cli-credentials");
    await fixture.lifecycle.stop();
  });

  it("rejects a legacy-data path that escapes through a parent symlink", async () => {
    const fixture = await createFixture();
    const outside = await temporaryDirectory("muxpilot-auth-parent-outside-");
    await mkdir(join(outside, "codex-auth-profiles"), { recursive: true });
    await writeFile(join(outside, "codex-auth-profiles", "saved-token"), "preserve");
    await mkdir(fixture.dataDir, { recursive: true });
    await symlink(outside, join(fixture.dataDir, "private"));

    await expect(fixture.lifecycle.start()).rejects.toThrow("Refusing to follow");

    expect(await readFile(join(outside, "codex-auth-profiles", "saved-token"), "utf8")).toBe("preserve");
    expect(await readFile(join(fixture.codexHome, "auth.json"), "utf8")).toBe("cli-credentials");
    await fixture.lifecycle.stop();
  });

  it("reconciles an externally selected account and invalidates dependent clients", async () => {
    const fixture = await createFixture([account("first@example.com"), account("second@example.com")]);
    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();
    fixture.hooks.invalidateConsumers.mockClear();
    fixture.hooks.reconcile.mockClear();

    const state = await fixture.lifecycle.refresh();

    expect(state.account?.email).toBe("second@example.com");
    expect(state.admissionHeld).toBe(false);
    expect(fixture.hooks.invalidateConsumers).toHaveBeenCalledOnce();
    expect(fixture.hooks.reconcile).toHaveBeenCalledOnce();
    await fixture.lifecycle.stop();
  });

  it("reconciles same-account credential replacement", async () => {
    const fixture = await createFixture([account("same@example.com"), account("same@example.com")]);
    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();
    fixture.hooks.invalidateConsumers.mockClear();
    fixture.hooks.reconcile.mockClear();
    await writeFile(join(fixture.codexHome, "auth.json"), "rotated-cli-credentials");

    await fixture.lifecycle.refresh();

    expect(fixture.hooks.invalidateConsumers).toHaveBeenCalledOnce();
    expect(fixture.hooks.reconcile).toHaveBeenCalledOnce();
    await fixture.lifecycle.stop();
  });

  it("ignores duplicate account notifications after verifying current CLI state", async () => {
    const fixture = await createFixture([account("same@example.com"), account("same@example.com")]);
    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();
    fixture.hooks.invalidateConsumers.mockClear();
    fixture.hooks.reconcile.mockClear();

    fixture.lifecycle.reportAccountUpdated();
    await vi.waitFor(() => expect(fixture.client.request).toHaveBeenCalledTimes(2));

    expect(fixture.lifecycle.state().admissionHeld).toBe(false);
    expect(fixture.hooks.reconcile).not.toHaveBeenCalled();
    expect(fixture.hooks.admissionReleased).toHaveBeenCalledTimes(2);
    await fixture.lifecycle.stop();
  });

  it("periodically detects a credential change missed by the file watcher", async () => {
    const fixture = await createFixture(
      [account("same@example.com"), account("same@example.com"), account("same@example.com")],
      10
    );
    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();
    fixture.hooks.invalidateConsumers.mockClear();
    fixture.hooks.reconcile.mockClear();
    await writeFile(join(fixture.codexHome, "auth.json"), "periodically-observed-credentials");

    await vi.waitFor(() => expect(fixture.hooks.invalidateConsumers).toHaveBeenCalled());
    await vi.waitFor(() => expect(fixture.lifecycle.state().admissionHeld).toBe(false));

    await fixture.lifecycle.stop();
  });

  it("does not release admission when another CLI account change arrives during reconciliation", async () => {
    const fixture = await createFixture([
      account("first@example.com"),
      account("second@example.com"),
      account("third@example.com")
    ]);
    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();
    fixture.hooks.admissionReleased.mockClear();
    fixture.hooks.reconcile.mockClear();
    const firstReconcile = deferred<string[]>();
    const secondReconcile = deferred<string[]>();
    fixture.hooks.reconcile
      .mockImplementationOnce(() => firstReconcile.promise)
      .mockImplementationOnce(() => secondReconcile.promise);

    await writeFile(join(fixture.codexHome, "auth.json"), "second-account-credentials");
    const firstRefresh = fixture.lifecycle.refresh();
    await vi.waitFor(() => expect(fixture.hooks.reconcile).toHaveBeenCalledTimes(1));
    await writeFile(join(fixture.codexHome, "auth.json"), "third-account-credentials");
    fixture.lifecycle.reportAccountUpdated();
    firstReconcile.resolve([]);
    await firstRefresh;

    expect(fixture.lifecycle.state().admissionHeld).toBe(true);
    expect(fixture.hooks.admissionReleased).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fixture.client.request).toHaveBeenCalledTimes(3));
    secondReconcile.resolve([]);
    await vi.waitFor(() => expect(fixture.lifecycle.state().admissionHeld).toBe(false));
    expect(fixture.lifecycle.state().account?.email).toBe("third@example.com");
    expect(fixture.hooks.admissionReleased).toHaveBeenCalledOnce();
    await fixture.lifecycle.stop();
  });

  it("suspends idle runtimes after CLI sign-out and gives CLI recovery guidance", async () => {
    const fixture = await createFixture([{ account: null, requiresOpenaiAuth: true }]);

    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();

    expect(fixture.lifecycle.state()).toMatchObject({ status: "signed_out", admissionHeld: true });
    expect(fixture.lifecycle.state().error).toContain("Codex CLI");
    expect(fixture.hooks.suspend).toHaveBeenCalledOnce();
    expect(fixture.hooks.reconcile).not.toHaveBeenCalled();
    await fixture.lifecycle.stop();
  });

  it("retries safe-boundary reconciliation even when credentials do not change again", async () => {
    const fixture = await createFixture([account("operator@example.com"), account("operator@example.com")]);
    fixture.hooks.reconcile.mockResolvedValueOnce(["busy-session"]).mockResolvedValueOnce([]);
    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();
    expect(fixture.lifecycle.state()).toMatchObject({ admissionHeld: true, pendingSessionIds: ["busy-session"] });
    expect(() => fixture.lifecycle.assertAvailable()).not.toThrow();
    expect(() => fixture.lifecycle.assertReady()).toThrow("Waiting for active sessions to reach a safe boundary.");

    const state = await fixture.lifecycle.refresh();

    expect(fixture.hooks.reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.hooks.reconcile).toHaveBeenNthCalledWith(1, null);
    expect(fixture.hooks.reconcile).toHaveBeenNthCalledWith(2, ["busy-session"]);
    expect(fixture.hooks.admissionReleased).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ status: "ready", admissionHeld: false, pendingSessionIds: [] });
    await fixture.lifecycle.stop();
  });

  it("distinguishes temporary observer failures and recovers without signing out", async () => {
    const fixture = await createFixture([new Error("network unavailable"), account("operator@example.com")]);
    await fixture.lifecycle.start();
    await fixture.lifecycle.reconcileAfterStartup();
    expect(fixture.lifecycle.state()).toMatchObject({ status: "temporarily_unavailable", admissionHeld: true });
    expect(() => fixture.lifecycle.assertAvailable()).toThrow("network unavailable");
    expect(() => fixture.lifecycle.assertReady()).toThrow("network unavailable");
    expect(fixture.hooks.blockers).toHaveBeenCalledOnce();

    const state = await fixture.lifecycle.refresh();

    expect(state).toMatchObject({ status: "ready", admissionHeld: false });
    expect(fixture.hooks.suspend).not.toHaveBeenCalled();
    await fixture.lifecycle.stop();
  });
});

async function createFixture(
  responses: Array<unknown | Error> = [account("operator@example.com")],
  reconcileIntervalMs: number | null = null
) {
  const root = await temporaryDirectory("muxpilot-auth-");
  const codexHome = join(root, "codex-home");
  const dataDir = join(root, "data");
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, "auth.json"), "cli-credentials");
  const queue = [...responses];
  const fallback = responses.at(-1);
  const request = vi.fn(async () => {
    const result = queue.length > 0 ? queue.shift() : fallback;
    if (result instanceof Error) throw result;
    return result;
  });
  const client = {
    request: request as <T = unknown>(method: string, params?: unknown) => Promise<T>,
    stop: vi.fn()
  };
  const clearProfiles = vi.fn(async () => undefined);
  const hooks = testHooks();
  const lifecycle = new CodexAuthLifecycle(
    { clearCodexAuthProfiles: clearProfiles },
    new EventBus(),
    codexHome,
    dataDir,
    undefined,
    { client, reconcileIntervalMs, watchCredentials: false }
  );
  lifecycle.setRuntimeHooks(hooks);
  return { lifecycle, hooks, clearProfiles, codexHome, dataDir, client: { ...client, request } };
}

function testHooks() {
  return {
    blockers: vi.fn(async () => []),
    reconcile: vi.fn(async () => []),
    suspend: vi.fn(async () => []),
    invalidateConsumers: vi.fn(),
    admissionReleased: vi.fn()
  };
}

function account(email: string) {
  return { account: { type: "chatgpt", email, planType: "pro" }, requiresOpenaiAuth: true };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
