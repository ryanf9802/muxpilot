import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config/config.js";
import { isLoopbackBindHost, randomAccessKey } from "../config/config.js";

const COOKIE_NAME = "muxpilot_operator";

export function createAccessControl(config: AppConfig, options: { unrestrictedRemoteAccessEnabled?: boolean } = {}) {
  let remoteAccessKey = config.operatorToken;
  let remoteAccessGeneration = 1;
  let unrestrictedRemoteAccessEnabled = options.unrestrictedRemoteAccessEnabled ?? false;
  const remoteSockets = new Set<{ close: () => void }>();

  function sign(): string {
    const payload = Buffer.from(JSON.stringify({ scope: "operator", generation: remoteAccessGeneration, iat: Date.now() })).toString("base64url");
    const signature = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  function verify(token: string | undefined): boolean {
    if (!token) return false;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;
    const expected = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { scope?: string; generation?: number };
      return parsed.scope === "operator" && parsed.generation === remoteAccessGeneration;
    } catch {
      return false;
    }
  }

  function currentAccessKey(): string {
    return remoteAccessKey;
  }

  function isLocalRequest(request: FastifyRequest): boolean {
    if (!isLoopbackAddress(request.ip)) return false;
    const forwardedAddress = headerValue(request.headers["x-muxpilot-client-address"]);
    if (forwardedAddress && !isLoopbackAddress(forwardedAddress)) return false;
    const forwardedHost = headerValue(request.headers["x-muxpilot-client-host"]);
    const host = forwardedHost ?? request.hostname;
    return isLoopbackBindHost(hostWithoutPort(host));
  }

  function hasAccess(request: FastifyRequest): boolean {
    return isLocalRequest(request) || unrestrictedRemoteAccessEnabled || hasRemoteCookieAccess(request);
  }

  function hasRemoteCookieAccess(request: FastifyRequest): boolean {
    return verify(request.cookies[COOKIE_NAME]);
  }

  async function requireAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!hasAccess(request)) {
      await reply.code(401).send({ error: "Operator access required" });
    }
  }

  async function requireLocalAccess(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!isLocalRequest(request)) {
      await reply.code(403).send({ error: "Local access required" });
    }
  }

  function revokeRemoteAccess(): string {
    remoteAccessKey = randomAccessKey();
    remoteAccessGeneration += 1;
    for (const socket of remoteSockets) socket.close();
    remoteSockets.clear();
    return remoteAccessKey;
  }

  function isUnrestrictedRemoteAccessEnabled(): boolean {
    return unrestrictedRemoteAccessEnabled;
  }

  function setUnrestrictedRemoteAccessEnabled(enabled: boolean): void {
    const changed = unrestrictedRemoteAccessEnabled !== enabled;
    unrestrictedRemoteAccessEnabled = enabled;
    if (changed && !enabled) revokeRemoteAccess();
  }

  function trackRemoteSocket(request: FastifyRequest, socket: { close: () => void }): void {
    if (isLocalRequest(request)) return;
    remoteSockets.add(socket);
  }

  function untrackRemoteSocket(socket: { close: () => void }): void {
    remoteSockets.delete(socket);
  }

  function register(app: FastifyInstance): void {
    app.post("/api/access", async (request, reply) => {
      if (isLocalRequest(request) || unrestrictedRemoteAccessEnabled) return { ok: true };

      const { accessKey } = parseAccessRequest(request.body);
      if (!accessKey || !tokensEqual(accessKey, remoteAccessKey)) {
        return reply.code(401).send({ error: "Invalid access key" });
      }
      reply.setCookie(COOKIE_NAME, sign(), {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: false
      });
      return { ok: true };
    });

    app.post("/api/logout", async (request, reply) => {
      if (!isLocalRequest(request) && hasRemoteCookieAccess(request)) revokeRemoteAccess();
      reply.clearCookie(COOKIE_NAME, { path: "/" });
      return { ok: true };
    });

    app.get("/api/me", async (request) => {
      const local = isLocalRequest(request);
      const accessGranted = hasAccess(request);
      return {
        accessGranted,
        accessKeyRequired: !local && !accessGranted,
        accessMode: local ? "local" : unrestrictedRemoteAccessEnabled ? "unrestricted" : "token",
        sessionHostMode: "local"
      };
    });
  }

  return {
    register,
    requireAccess,
    requireLocalAccess,
    hasAccess,
    isLocalRequest,
    currentAccessKey,
    isUnrestrictedRemoteAccessEnabled,
    setUnrestrictedRemoteAccessEnabled,
    revokeRemoteAccess,
    trackRemoteSocket,
    untrackRemoteSocket,
    verify
  };
}

export type AccessControl = ReturnType<typeof createAccessControl>;

function parseAccessRequest(body: unknown): { accessKey?: string } {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  return {
    accessKey: typeof record.accessKey === "string" ? record.accessKey : undefined
  };
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function hostWithoutPort(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  if (trimmed.includes(":") && trimmed.indexOf(":") !== trimmed.lastIndexOf(":")) return trimmed;
  return trimmed.split(":")[0] ?? trimmed;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized === "::ffff:127.0.0.1" || normalized.startsWith("127.");
}
