import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import type { AppDatabase } from "../db/database.js";
import type { MessageContentPart } from "@muxpilot/core";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
type ImageMime = keyof typeof MIME_EXTENSIONS;

export class SessionImageError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export class SessionImageService {
  private readonly root: string;
  constructor(dataDir: string, private readonly db: AppDatabase) {
    this.root = resolve(dataDir, "session-images");
  }

  async store(sessionId: string, mimeType: string, encoded: string): Promise<MessageContentPart & { type: "image" }> {
    if (!await this.db.getSession(sessionId)) throw new SessionImageError("Session not found", 404);
    if (!(mimeType in MIME_EXTENSIONS)) throw new SessionImageError("Only PNG, JPEG, and WebP images are supported");
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new SessionImageError("Images must be between 1 byte and 10 MiB");
    if (!matchesMime(bytes, mimeType as ImageMime)) throw new SessionImageError("Image contents do not match the declared format");
    const id = `${nanoid()}.${MIME_EXTENSIONS[mimeType as ImageMime]}`;
    const directory = this.assetPath(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(this.assetPath(sessionId, id), bytes, { mode: 0o600, flag: "wx" });
    return { type: "image", id, mimeType: mimeType as ImageMime };
  }

  async read(sessionId: string, id: string): Promise<{ bytes: Buffer; mimeType: ImageMime }> {
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(id)) throw new SessionImageError("Image not found", 404);
    if (!await this.db.getSession(sessionId)) throw new SessionImageError("Image not found", 404);
    const extension = id.slice(id.lastIndexOf(".") + 1);
    const mimeType: ImageMime = extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : "image/webp";
    try { return { bytes: await readFile(this.assetPath(sessionId, id)), mimeType }; }
    catch { throw new SessionImageError("Image not found", 404); }
  }

  path(sessionId: string, id: string): string {
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(id)) throw new SessionImageError("Invalid image reference");
    return this.assetPath(sessionId, id);
  }

  async validate(sessionId: string, content?: MessageContentPart[]): Promise<void> {
    await Promise.all((content ?? []).filter((part): part is MessageContentPart & { type: "image" } => part.type === "image")
      .map(async (part) => {
        const stored = await this.read(sessionId, part.id);
        if (stored.mimeType !== part.mimeType) throw new SessionImageError("Image reference format does not match stored image");
      }));
  }

  private assetPath(sessionId: string, id?: string): string {
    const path = resolve(this.root, sessionId, ...(id ? [id] : []));
    if (!path.startsWith(`${this.root}${sep}`)) throw new SessionImageError("Invalid session image path");
    return path;
  }
}

function matchesMime(bytes: Buffer, mime: ImageMime): boolean {
  if (mime === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
}
