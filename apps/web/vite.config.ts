import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const apiTarget = process.env.MUXPILOT_API_TARGET ?? "http://127.0.0.1:4177";
const https = viteHttpsConfig();

function applyClientHeaders(
  proxyReq: { setHeader: (name: string, value: string) => void },
  req: { headers: { host?: string; origin?: string; referer?: string }; socket: { remoteAddress?: string } }
) {
  const clientHost = browserVisibleHost(req.headers);
  if (clientHost) proxyReq.setHeader("x-muxpilot-client-host", clientHost);
  if (req.socket.remoteAddress) proxyReq.setHeader("x-muxpilot-client-address", req.socket.remoteAddress);
}

function browserVisibleHost(headers: { host?: string; origin?: string; referer?: string }): string | undefined {
  if (headers.host && !isLoopbackHost(hostWithoutPort(headers.host))) return headers.host;

  const originHost = hostFromUrl(headers.origin);
  if (originHost && !isLoopbackHost(hostWithoutPort(originHost))) return originHost;

  const refererHost = hostFromUrl(headers.referer);
  if (refererHost && !isLoopbackHost(hostWithoutPort(refererHost))) return refererHost;

  return headers.host;
}

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}

function hostWithoutPort(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  if (trimmed.includes(":") && trimmed.indexOf(":") !== trimmed.lastIndexOf(":")) return trimmed;
  return trimmed.split(":")[0] ?? trimmed;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized.startsWith("127.");
}

const proxy: Record<string, ProxyOptions> = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
    ws: true,
    configure: (proxy) => {
      proxy.on("proxyReq", applyClientHeaders);
      proxy.on("proxyReqWs", applyClientHeaders);
    }
  }
};

export default defineConfig({
  plugins: [react()],
  server: {
    https,
    proxy
  },
  preview: {
    https,
    proxy
  }
});

function viteHttpsConfig(): { cert: Buffer; key: Buffer } | undefined {
  const certPath = process.env.MUXPILOT_HTTPS_CERT;
  const keyPath = process.env.MUXPILOT_HTTPS_KEY;
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    throw new Error("MUXPILOT_HTTPS_CERT and MUXPILOT_HTTPS_KEY must be set together.");
  }
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath)
  };
}
