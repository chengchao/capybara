import type { Conversation } from "./transcript";

// Conversation history is persisted by the main process as one inspectable JSON
// file per conversation under userData/conversations/ (see
// electron/conversations.ts), which also repairs a stale "running" status and
// tolerates a corrupt file. These are thin bridge wrappers; hydration is async
// (load all on startup), and saves are per-conversation so only the one that
// changed is rewritten.
export function loadConversations(): Promise<Conversation[]> {
  return window.capybara.getConversations();
}

export function saveConversation(conversation: Conversation): Promise<void> {
  return window.capybara.saveConversation(conversation);
}
