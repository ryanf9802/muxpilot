import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/db/database.js";
import { SessionImageService } from "../src/services/sessionImages.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("SessionImageService", () => {
  it("stores a validated session-owned image and resolves its local path", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-images-"));
    roots.push(root);
    const db = { getSession: async (id: string) => id === "session-1" ? { id } : null } as AppDatabase;
    const service = new SessionImageService(root, db);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

    const image = await service.store("session-1", "image/png", png.toString("base64"));
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(service.path("session-1", image.id)).toContain(`/session-images/session-1/${image.id}`);
    await expect(service.read("session-1", image.id)).resolves.toMatchObject({ bytes: png, mimeType: "image/png" });
  });

  it("rejects unsupported, spoofed, and unknown-session images", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-images-"));
    roots.push(root);
    const db = { getSession: async () => null } as unknown as AppDatabase;
    const service = new SessionImageService(root, db);
    await expect(service.store("missing", "image/png", "AA==")).rejects.toMatchObject({ statusCode: 404 });

    const existing = new SessionImageService(root, { getSession: async () => ({ id: "session-1" }) } as AppDatabase);
    await expect(existing.store("session-1", "image/gif", "R0lGODlh")).rejects.toThrow("Only PNG");
    await expect(existing.store("session-1", "image/png", "R0lGODlh")).rejects.toThrow("do not match");
  });

  it("keeps image paths inside the configured storage root", () => {
    const service = new SessionImageService("/tmp/muxpilot-images-root", {} as AppDatabase);
    expect(() => service.path("..", "escape.png")).toThrow("Invalid session image path");
  });
});
