import fs from "node:fs";
import path from "node:path";

// Conversation history persisted as one inspectable JSON file PER conversation
// under userData/conversations/, so a single conversation's update rewrites only
// its own file (not the whole history). It's a display cache, not the source of
// truth: the agent's real session history lives with the SDK (resumed via
// `sessionId`) and folder grants live in main's in-memory store.
//
// Main is a dumb store: it reads/writes raw JSON and stays agnostic to the
// transcript shape. The renderer (src/lib/transcript.ts) owns the Conversation
// schema and validates every record on load, dropping a corrupt/partial/older
// file and applying the stale-"running" repair — so the shape logic lives in one
// place, next to the type.

function conversationsDir(): string {
  // Lazy require so isSafeId stays importable under bun:test, where evaluating
  // the "electron" module fails (it's a runtime-only binding).
  const { app } = require("electron") as typeof import("electron");
  return path.join(app.getPath("userData"), "conversations");
}

// A conversation file is named <id>.json. Only a plain slug is allowed so a
// crafted id can't write outside the directory (path traversal); the app's ids
// are crypto.randomUUID(), which fit comfortably.
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

// Read every conversation file as raw parsed JSON, skipping any that won't parse
// rather than failing the whole load. The renderer validates each against the
// Conversation schema and drops bad shapes, so the order/contents here are
// untrusted. A missing directory (first run) yields an empty list.
export function loadConversations(): unknown[] {
  const dir = conversationsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {
      // Skip a single corrupt (unparseable) file rather than failing the load.
    }
  }
  return out;
}

// Created once per process; avoids a mkdir+chmod syscall on every streaming write.
let dirEnsured = false;

// Write one conversation to <id>.json. Transcripts can include contents the agent
// Read from host files, so keep each file (and the directory) owner-only (chmod
// every write — see settings.ts for the why).
export function saveConversation(conversation: unknown): void {
  const c = conversation as { id?: unknown };
  if (!isSafeId(c?.id)) return;
  try {
    const dir = conversationsDir();
    if (!dirEnsured) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      dirEnsured = true;
    }
    const p = path.join(dir, `${c.id}.json`);
    fs.writeFileSync(p, JSON.stringify(conversation, null, 2), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  } catch {
    // Best-effort: a write failure shouldn't break the session.
  }
}
