import type { Conversation } from "./transcript";

// Conversation history is persisted in the renderer's localStorage. It's a
// display cache, not the source of truth: the agent's real session history lives
// with the SDK (resumed via `sessionId`) and folder grants live in main's
// in-memory store. So a reload rehydrates the transcript for viewing, and a task
// resumed later re-drives the actual session. (If the transcript volume ever
// outgrows localStorage's ~5 MB, move this to a JSON file under userData like
// electron/settings.ts — same shape, no model change.)
const STORAGE_KEY = "capybara.conversations.v1";

// A persisted "running" status is stale — the task that was in flight didn't
// survive the reload — so settle it to "done" with no live taskId. Anything that
// doesn't parse into an array is treated as empty rather than throwing.
export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c) => (c.status === "running" ? { ...c, status: "done", taskId: null } : c));
  } catch {
    return [];
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch {
    // Best-effort: a quota or serialization failure shouldn't break the session.
  }
}
