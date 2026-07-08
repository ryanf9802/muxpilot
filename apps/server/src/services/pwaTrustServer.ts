import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, join, resolve } from "node:path";
import type { AppConfig } from "../config/config.js";
import { isLoopbackBindHost } from "../config/config.js";

const TRUST_FILES = new Map([
  ["/muxpilot-root-ca.pem", "muxpilot-root-ca.pem"],
  ["/muxpilot-root-ca.crt", "muxpilot-root-ca.crt"],
  ["/muxpilot-root-ca.crl", "muxpilot-root-ca.crl"],
  ["/muxpilot-root-ca.mobileconfig", "muxpilot-root-ca.mobileconfig"]
]);

export class PwaTrustServer {
  private server: Server | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: { info: (data: object, message?: string) => void; warn: (data: object, message?: string) => void }
  ) {}

  start(): void {
    if (!this.config.pwaTrustDir || isLoopbackBindHost(this.config.host)) return;
    const missingFile = requiredTrustFiles(this.config.pwaTrustDir).find((path) => !existsSync(path));
    if (missingFile) {
      this.logger.warn({ missingFile }, "PWA trust server not started because trust files are missing");
      return;
    }

    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(trustIndexHtml());
        return;
      }

      const filename = TRUST_FILES.get(url.pathname);
      if (!filename) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }

      const filePath = join(this.config.pwaTrustDir!, filename);
      if (!safeRegularFile(this.config.pwaTrustDir!, filePath)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
        return;
      }

      response.writeHead(200, {
        "content-type": contentType(filename),
        "content-disposition": `attachment; filename="${basename(filename)}"`
      });
      response.end(readFileSync(filePath));
    });

    this.server.on("error", (error) => {
      this.logger.warn({ err: error, port: this.config.pwaTrustPort }, "PWA trust server failed");
      this.server?.close(() => undefined);
      this.server = null;
    });
    this.server.listen({ host: this.config.host, port: this.config.pwaTrustPort }, () => {
      this.logger.info({ port: this.config.pwaTrustPort, trustDir: this.config.pwaTrustDir }, "PWA trust server started");
    });
  }

  close(): Promise<void> {
    return new Promise((resolveClose, rejectClose) => {
      if (!this.server) {
        resolveClose();
        return;
      }
      this.server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }
}

function requiredTrustFiles(trustDir: string): string[] {
  return [...TRUST_FILES.values()].map((filename) => join(trustDir, filename));
}

function safeRegularFile(trustDir: string, filePath: string): boolean {
  const resolvedTrustDir = resolve(trustDir);
  const resolvedFilePath = resolve(filePath);
  if (!resolvedFilePath.startsWith(`${resolvedTrustDir}/`)) return false;
  try {
    return statSync(resolvedFilePath).isFile();
  } catch {
    return false;
  }
}

function contentType(filename: string): string {
  if (filename.endsWith(".mobileconfig")) return "application/x-apple-aspen-config";
  if (filename.endsWith(".crl")) return "application/pkix-crl";
  return "application/x-pem-file";
}

function trustIndexHtml(): string {
  const links = [...TRUST_FILES.keys()].map((path) => `<li><a href="${path}">${path.slice(1)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>muxpilot CA</title></head>
<body>
  <h1>muxpilot Root CA</h1>
  <p>Install the public root CA on this device before opening the muxpilot HTTPS app URL.</p>
  <ul>${links}</ul>
  <p>This server only serves public trust files.</p>
</body>
</html>
`;
}
