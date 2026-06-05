import fs from "node:fs";
import path from "node:path";

// Conversation history persisted as an inspectable JSON file under userData,
// mirroring settings.ts. It's a display cache, not the source of truth: the
// agent's real session history lives with the SDK (resumed via `sessionId`) and
// folder grants live in main's in-memory store. Main treats each conversation as
// opaque JSON except for the one repair below — the renderer owns the shape.
type StoredConversation = { status?: string; taskId?: unknown };

function conversationsPath(): string {
  // Lazy require so the pure sanitizeStored() stays importable under bun:test,
  // where evaluating the "electron" module fails (it's a runtime-only binding).
  const { app } = require("electron") as typeof import("electron");
  return path.join(app.getPath("userData"), "conversations.json");
}

// A persisted "running" status is stale — the task that was in flight didn't
// survive the restart — so settle it to "done" with no live taskId. Anything that
// isn't an array of objects is treated as empty rather than trusted.
export function sanitizeStored(parsed: unknown): StoredConversation[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((c) =>
    c && typeof c === "object" && (c as StoredConversation).status === "running"
      ? { ...(c as StoredConversation), status: "done", taskId: null }
      : (c as StoredConversation),
  );
}

export function loadConversations(): StoredConversation[] {
  try {
    return sanitizeStored(JSON.parse(fs.readFileSync(conversationsPath(), "utf8")));
  } catch {
    return [];
  }
}

export function saveConversations(conversations: unknown): void {
  try {
    const p = conversationsPath();
    // Transcripts can include contents the agent Read from host files, so keep
    // the file owner-only (chmod every write — see settings.ts for the why).
    fs.writeFileSync(p, JSON.stringify(conversations, null, 2), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  } catch {
    // Best-effort: a write failure shouldn't break the session.
  }
}
