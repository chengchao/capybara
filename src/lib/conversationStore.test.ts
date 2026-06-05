import { beforeEach, expect, test } from "bun:test";

import { loadConversations, saveConversations } from "./conversationStore";
import { emptyConversation, type Conversation } from "./transcript";

// bun:test has no DOM, so stand up a minimal in-memory localStorage.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

const KEY = "capybara.conversations.v1";

test("save then load round-trips the conversations", () => {
  const convos: Conversation[] = [
    { ...emptyConversation("a"), sessionId: "s1" },
    emptyConversation("b"),
  ];
  saveConversations(convos);
  expect(loadConversations()).toEqual(convos);
});

test("loading with nothing stored yields an empty list", () => {
  expect(loadConversations()).toEqual([]);
});

test("a persisted running status is settled to done with no taskId", () => {
  const convos: Conversation[] = [{ ...emptyConversation("a"), status: "running", taskId: "t1" }];
  saveConversations(convos);
  const [c] = loadConversations();
  expect(c.status).toBe("done");
  expect(c.taskId).toBeNull();
});

test("corrupt JSON loads as an empty list rather than throwing", () => {
  store.set(KEY, "{not json");
  expect(loadConversations()).toEqual([]);
});

test("a non-array payload loads as an empty list", () => {
  store.set(KEY, JSON.stringify({ nope: true }));
  expect(loadConversations()).toEqual([]);
});
