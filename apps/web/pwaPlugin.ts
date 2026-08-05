import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const BUILD_ID_TOKEN = "__MUXPILOT_BUILD_ID__";

export function pwaServiceWorkerPlugin(): Plugin {
  return {
    name: "muxpilot-pwa-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const template = readFileSync(new URL("./sw-template.js", import.meta.url), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: renderServiceWorker(template, bundleBuildId(bundle))
      });
    }
  };
}

export type PwaBuildBundle = Record<string, PwaBuildArtifact>;

type PwaBuildArtifact =
  | { type: "chunk"; fileName: string; code: string }
  | { type: "asset"; fileName: string; source: string | Uint8Array };

export function bundleBuildId(bundle: PwaBuildBundle): string {
  const hash = createHash("sha256");
  for (const artifact of Object.values(bundle).sort((left, right) => left.fileName.localeCompare(right.fileName))) {
    hash.update(artifact.fileName);
    hash.update("\0");
    hash.update(artifactContents(artifact));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function renderServiceWorker(template: string, buildId: string): string {
  const occurrences = template.split(BUILD_ID_TOKEN).length - 1;
  if (occurrences !== 1) throw new Error(`Expected exactly one ${BUILD_ID_TOKEN} token in the service worker template.`);
  return template.replace(BUILD_ID_TOKEN, buildId);
}

function artifactContents(artifact: PwaBuildArtifact): string | Uint8Array {
  if (artifact.type === "chunk") return artifact.code;
  return typeof artifact.source === "string" ? artifact.source : new Uint8Array(artifact.source);
}
