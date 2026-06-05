import { type Conversation, parseStoredConversation } from "./transcript";

// Conversation history is persisted by the main process as one inspectable JSON
// file per conversation under userData/conversations/ (see
// electron/conversations.ts). Main returns the raw parsed records untrusted; this
// layer validates each against the Conversation schema — dropping any corrupt,
// partial, or older-shape file so it can't crash the renderer — repairs a stale
// "running" status, and sorts newest-first. Saves are per-conversation so only
// the one that changed is rewritten.
export async function loadConversations(): Promise<Conversation[]> {
  const raw = await window.capybara.getConversations();
  const valid = (Array.isArray(raw) ? raw : [])
    .map(parseStoredConversation)
    .filter((c): c is Conversation => c !== null);
  return valid.sort((a, b) => b.createdAt - a.createdAt);
}

export function saveConversation(conversation: Conversation): Promise<void> {
  return window.capybara.saveConversation(conversation);
}
