import type { Conversation } from "./transcript";

// Conversation history is persisted by the main process as an inspectable JSON
// file under userData (see electron/conversations.ts), which also repairs a stale
// "running" status and tolerates a corrupt file. These are thin bridge wrappers;
// hydration is therefore async (load on startup, save on change).
export function loadConversations(): Promise<Conversation[]> {
  return window.capybara.getConversations();
}

export function saveConversations(conversations: Conversation[]): Promise<void> {
  return window.capybara.saveConversations(conversations);
}
