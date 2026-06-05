import fs from "node:fs";
import path from "node:path";

// Conversation history persisted as one inspectable JSON file PER conversation
// under userData/conversations/, so a single conversation's update rewrites only
// its own file (not the whole history). It's a display cache, not the source of
// truth: the agent's real session history lives with the SDK (resumed via
// `sessionId`) and folder grants live in main's in-memory store. Main treats each
// conversation as opaque JSON except for the stale-"running" repair below — the
// renderer owns the shape.
type StoredConversation = { id?: unknown; createdAt?: unknown; status?: string; taskId?: unknown };

function conversationsDir(): string {
  // Lazy require so the pure helpers stay importable under bun:test, where
  // evaluating the "electron" module fails (it's a runtime-only binding).
  const { app } = require("electron") as typeof import("electron");
  return path.join(app.getPath("userData"), "conversations");
}

// A conversation file is named <id>.json. Only a plain slug is allowed so a
// crafted id can't write outside the directory (path traversal); the app's ids
// are crypto.randomUUID(), which fit comfortably.
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

// A persisted "running" status is stale — the task that was in flight didn't
// survive the restart — so settle it to "done" with no live taskId. A non-object
// returns null (the caller drops it) rather than being trusted.
export function sanitizeOne(parsed: unknown): StoredConversation | null {
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as StoredConversation;
  return c.status === "running" ? { ...c, status: "done", taskId: null } : c;
}

// Read every conversation file, newest first (by createdAt), dropping any that
// won't parse rather than losing the whole history. A missing directory (first
// run) yields an empty list.
export function loadConversations(): StoredConversation[] {
  let files: string[];
  try {
    files = fs.readdirSync(conversationsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const dir = conversationsDir();
  const out: StoredConversation[] = [];
  for (const f of files) {
    try {
      const one = sanitizeOne(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      if (one) out.push(one);
    } catch {
      // Skip a single corrupt file rather than failing the whole load.
    }
  }
  return out.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
}

// Write one conversation to <id>.json. Transcripts can include contents the agent
// Read from host files, so keep each file (and the directory) owner-only (chmod
// every write — see settings.ts for the why).
export function saveConversation(conversation: unknown): void {
  const c = conversation as StoredConversation;
  if (!isSafeId(c?.id)) return;
  try {
    const dir = conversationsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = path.join(dir, `${c.id}.json`);
    fs.writeFileSync(p, JSON.stringify(conversation, null, 2), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  } catch {
    // Best-effort: a write failure shouldn't break the session.
  }
}
