import { createHash } from "node:crypto";
import { nanoid } from "nanoid";

export function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function eventId(): string {
  return nanoid(16);
}

