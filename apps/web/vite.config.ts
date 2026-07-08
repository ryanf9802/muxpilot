import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const apiTarget = process.env.MUXPILOT_API_TARGET ?? "http://127.0.0.1:4177";
const https = viteHttpsConfig();
function applyClientHeaders(proxyReq: { setHeader: (name: string, value: string) => void }, req: { headers: { host?: string }; socket: { remoteAddress?: string } }) {
  if (req.headers.host) proxyReq.setHeader("x-muxpilot-client-host", req.headers.host);
  if (req.socket.remoteAddress) proxyReq.setHeader("x-muxpilot-client-address", req.socket.remoteAddress);
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
