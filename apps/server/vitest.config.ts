import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@muxpilot/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@muxpilot/git-workspaces": resolve(__dirname, "../../packages/git-workspaces/src/index.ts")
    }
  }
});
