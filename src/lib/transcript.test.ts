import { expect, test } from "bun:test";

import type { AgentEvent } from "./host";
import { addUser, applyEvent, emptyConversation, originFor, resolveConsent } from "./transcript";

const fold = (events: AgentEvent[]) => events.reduce(applyEvent, emptyConversation());
const T = "t1";

test("origin: Bash routes to the VM, file tools to the host", () => {
  expect(originFor("Bash")).toBe("vm");
  expect(originFor("Read")).toBe("host");
  expect(originFor("Glob")).toBe("host");
  expect(originFor("Write")).toBe("host");
});

test("task_started / session_started / task_finished set top-level state", () => {
  const c = fold([
    { event: "task_started", taskId: T },
    { event: "session_started", taskId: T, sessionId: "abc-123" },
    { event: "task_finished", taskId: T, sessionId: "abc-123" },
  ]);
  expect(c.sessionId).toBe("abc-123");
  expect(c.status).toBe("done");
});

test("task_started captures the taskId for cancellation", () => {
  expect(emptyConversation().taskId).toBeNull();
  const c = applyEvent(emptyConversation(), { event: "task_started", taskId: "task-9" });
  expect(c.taskId).toBe("task-9");
  expect(c.status).toBe("running");
});

test("assistant_message becomes a text block in an assistant turn", () => {
  const c = fold([{ event: "assistant_message", taskId: T, text: "Hello" }]);
  expect(c.items).toHaveLength(1);
  expect(c.items[0]).toMatchObject({ role: "assistant" });
  const turn = c.items[0] as { blocks: unknown[] };
  expect(turn.blocks[0]).toMatchObject({ kind: "text", text: "Hello" });
});

test("tool_use pairs with tool_result by toolUseId; origin is derived", () => {
  const c = fold([
    { event: "tool_use", taskId: T, tool: "Read", input: { file_path: "/x" }, toolUseId: "u1" },
    { event: "tool_result", taskId: T, toolUseId: "u1", content: "file body", isError: false },
  ]);
  const turn = c.items[0] as { blocks: Array<Record<string, unknown>> };
  expect(turn.blocks[0]).toMatchObject({
    kind: "tool",
    id: "u1",
    name: "Read",
    origin: "host",
    status: "done",
    result: "file body",
  });
});

test("a tool_result with isError marks the tool errored", () => {
  const c = fold([
    { event: "tool_use", taskId: T, tool: "Bash", input: { command: "ls" }, toolUseId: "u9" },
    { event: "tool_result", taskId: T, toolUseId: "u9", content: "boom", isError: true },
  ]);
  const turn = c.items[0] as { blocks: Array<Record<string, unknown>> };
  expect(turn.blocks[0]).toMatchObject({ origin: "vm", status: "error" });
});

test("text + tools group into one assistant turn", () => {
  const c = fold([
    { event: "assistant_message", taskId: T, text: "Let me look" },
    { event: "tool_use", taskId: T, tool: "Read", input: {}, toolUseId: "u1" },
    { event: "assistant_message", taskId: T, text: "Found it" },
  ]);
  expect(c.items).toHaveLength(1);
  const turn = c.items[0] as { blocks: unknown[] };
  expect(turn.blocks).toHaveLength(3);
});

test("a user message between assistant output starts a fresh turn", () => {
  let c = fold([{ event: "assistant_message", taskId: T, text: "one" }]);
  c = addUser(c, "again");
  c = applyEvent(c, { event: "assistant_message", taskId: T, text: "two" });
  expect(c.items.map((i) => i.role)).toEqual(["assistant", "user", "assistant"]);
});

test("tool_result for an unknown toolUseId is a no-op", () => {
  const before = fold([{ event: "assistant_message", taskId: T, text: "hi" }]);
  const after = applyEvent(before, {
    event: "tool_result",
    taskId: T,
    toolUseId: "nope",
    content: "x",
    isError: false,
  });
  expect(after.items).toEqual(before.items);
});

test("a realistic run folds into user → assistant(text, tool, text)", () => {
  const c = fold([
    { event: "task_started", taskId: T },
    { event: "session_started", taskId: T, sessionId: "s1" },
    { event: "assistant_message", taskId: T, text: "On it." },
    { event: "tool_use", taskId: T, tool: "Bash", input: { command: "ls" }, toolUseId: "u1" },
    { event: "tool_result", taskId: T, toolUseId: "u1", content: "a\nb", isError: false },
    { event: "assistant_message", taskId: T, text: "Done." },
    { event: "task_finished", taskId: T, sessionId: "s1" },
  ]);
  const withUser = applyEvent(addUser(emptyConversation(), "run ls"), {
    event: "task_started",
    taskId: T,
  });
  expect(withUser.items[0]).toMatchObject({ role: "user", text: "run ls" });
  expect(c.status).toBe("done");
  const turn = c.items[0] as { blocks: Array<{ kind: string }> };
  expect(turn.blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
});

test("consent_request becomes a pending consent block", () => {
  const c = fold([{ event: "consent_request", requestId: "c1", path: "/Users/x/Desktop" }]);
  const turn = c.items[0] as { blocks: Array<Record<string, unknown>> };
  expect(turn.blocks[0]).toMatchObject({
    kind: "consent",
    id: "c1",
    path: "/Users/x/Desktop",
    state: "pending",
  });
});

test("the request_capybara_directory tool call is suppressed (consent card stands in)", () => {
  const c = fold([
    {
      event: "tool_use",
      taskId: T,
      tool: "request_capybara_directory",
      input: {},
      toolUseId: "u1",
    },
    { event: "consent_request", requestId: "c1", path: "/Users/x/Desktop" },
  ]);
  const turn = c.items[0] as { blocks: Array<{ kind: string }> };
  expect(turn.blocks.map((b) => b.kind)).toEqual(["consent"]);
});

test("allowing a consent resolves the card and adds the folder to grants", () => {
  let c = fold([{ event: "consent_request", requestId: "c1", path: "/Users/x/Desktop" }]);
  c = resolveConsent(c, "c1", "allow");
  expect(c.grants).toEqual(["/Users/x/Desktop"]);
  const turn = c.items[0] as { blocks: Array<Record<string, unknown>> };
  expect(turn.blocks[0]).toMatchObject({ state: "allow" });
});

test("denying a consent resolves the card without granting", () => {
  let c = fold([{ event: "consent_request", requestId: "c1", path: "/Users/x/Desktop" }]);
  c = resolveConsent(c, "c1", "deny");
  expect(c.grants).toEqual([]);
  const turn = c.items[0] as { blocks: Array<Record<string, unknown>> };
  expect(turn.blocks[0]).toMatchObject({ state: "deny" });
});
