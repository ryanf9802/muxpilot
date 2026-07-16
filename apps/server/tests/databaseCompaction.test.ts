import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { compactDatabase } from "../../../scripts/compact-dbs.mjs";

describe("database compaction", () => {
  it("removes transient events while preserving application data and a backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-compact-"));
    const dbPath = join(dir, "muxpilot.db");
    const backupPath = join(dir, "muxpilot.backup.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE managed_sessions (id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, session_id TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO managed_sessions (id, data_json) VALUES (?, ?)").run("session-a", '{"name":"kept"}');
    db.prepare("INSERT INTO messages (id, session_id, text) VALUES (?, ?, ?)").run("message-a", "session-a", "kept message");
    const insertEvent = db.prepare(
      "INSERT INTO events (id, type, session_id, payload_json, timestamp) VALUES (?, ?, ?, ?, ?)"
    );
    for (let index = 0; index < 40; index += 1) {
      insertEvent.run(
        `event-${index}`,
        "message.appended",
        "session-a",
        JSON.stringify({ text: "x".repeat(32 * 1024) }),
        "2026-07-16T00:00:00.000Z"
      );
    }
    db.close();

    const result = await compactDatabase(dbPath, { backupPath, timestamp: "2026-07-16T00:00:00.000Z" });

    expect(result.eventRowsRemoved).toBe(40);
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);
    await expect(access(backupPath)).resolves.toBeUndefined();
    expect((await stat(backupPath)).size).toBe(result.beforeBytes);

    const compacted = new DatabaseSync(dbPath, { readOnly: true });
    expect(compacted.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    expect(compacted.prepare("SELECT data_json FROM managed_sessions WHERE id = ?").get("session-a")).toEqual({
      data_json: '{"name":"kept"}'
    });
    expect(compacted.prepare("SELECT text FROM messages WHERE id = ?").get("message-a")).toEqual({
      text: "kept message"
    });
    expect(compacted.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    compacted.close();

    const backup = new DatabaseSync(backupPath, { readOnly: true });
    expect(backup.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 40 });
    backup.close();
  });
});
