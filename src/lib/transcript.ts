import type { AgentEvent } from "./host";

// A conversation is the AgentEvent stream folded into a structured tree the UI
// can render directly. `applyEvent` is pure — feed it events in order and it
// builds turns, pairing tool_use ↔ tool_result by toolUseId. See
// docs/frontend-implementation.html for the design.

export type Origin = "host" | "vm";

export type TextBlock = { kind: "text"; id: string; text: string };
export type ToolBlock = {
  kind: "tool";
  id: string; // the toolUseId
  name: string;
  origin: Origin;
  input: unknown;
  result?: unknown;
  status: "running" | "done" | "error";
};
export type ConsentBlock = {
  kind: "consent";
  id: string; // the broker's requestId
  path: string;
  // "cancelled" = the task ended (finished or Stopped) while the prompt was
  // still pending, so the broker already resolved it as a deny — the card goes
  // inert rather than dangling with live Allow/Deny buttons.
  state: "pending" | "allow" | "deny" | "cancelled";
};
export type Block = TextBlock | ToolBlock | ConsentBlock;

export type ServiceItem = { id: string; role: "service"; text: string };
export type UserItem = { id: string; role: "user"; text: string };
export type AssistantItem = { id: string; role: "assistant"; blocks: Block[] };
export type Item = ServiceItem | UserItem | AssistantItem;

export type Conversation = {
  id: string; // stable renderer-side key; survives across resumes, present before sessionId
  sessionId: string | null; // the SDK session, set on session_started; resume key
  taskId: string | null; // the in-flight task, for cancellation
  status: "idle" | "running" | "done";
  items: Item[];
  grants: string[]; // host directories the user has approved this conversation
};

// `id` is the conversation's stable identity in the history list. It exists from
// creation (the SDK sessionId only arrives once a task runs), so the list and the
// event routing key off it, not sessionId.
export function emptyConversation(id: string = crypto.randomUUID()): Conversation {
  return { id, sessionId: null, taskId: null, status: "idle", items: [], grants: [] };
}

// Bash is the only tool that leaves for the VM sandbox; the built-in file tools
// (Read/Glob/Write/…) run on the host. Names arrive already stripped of the
// `mcp__capybara__` prefix by the event relay in runTask.ts.
export function originFor(toolName: string): Origin {
  return toolName === "Bash" ? "vm" : "host";
}

// Append a block to the current assistant turn, starting a new turn when the
// last item isn't an assistant turn (i.e. after a user/service item, or first).
function appendBlock(
  c: Conversation,
  make: (turnId: string, index: number) => Block,
): Conversation {
  const items = c.items.slice();
  const last = items[items.length - 1];
  let turn: AssistantItem;
  if (last && last.role === "assistant") {
    turn = { ...last, blocks: last.blocks.slice() };
    items[items.length - 1] = turn;
  } else {
    turn = { id: `i${items.length}`, role: "assistant", blocks: [] };
    items.push(turn);
  }
  turn.blocks.push(make(turn.id, turn.blocks.length));
  return { ...c, items };
}

function updateTool(c: Conversation, id: string, result: unknown, isError: boolean): Conversation {
  return {
    ...c,
    items: c.items.map((it) =>
      it.role === "assistant"
        ? {
            ...it,
            blocks: it.blocks.map((b) =>
              b.kind === "tool" && b.id === id
                ? { ...b, result, status: isError ? "error" : "done" }
                : b,
            ),
          }
        : it,
    ),
  };
}

export function applyEvent(c: Conversation, e: AgentEvent): Conversation {
  switch (e.event) {
    case "task_started":
      return { ...c, status: "running", taskId: e.taskId };
    case "session_started":
      return { ...c, sessionId: e.sessionId };
    case "assistant_message":
      return appendBlock(c, (turnId, n) => ({ kind: "text", id: `${turnId}-b${n}`, text: e.text }));
    case "tool_use":
      return appendBlock(c, () => ({
        kind: "tool",
        id: e.toolUseId,
        name: e.tool,
        origin: originFor(e.tool),
        input: e.input,
        status: "running",
      }));
    case "tool_result":
      return updateTool(c, e.toolUseId, e.content, e.isError);
    case "task_finished":
      return cancelPendingConsents({ ...c, status: "done" });
    case "consent_request":
      return appendBlock(c, () => ({
        kind: "consent",
        id: e.requestId,
        path: e.path,
        state: "pending",
      }));
    case "grant_added":
      // Main's authoritative store is the source of truth for grants — record
      // the normalized path it reports (deduped).
      return c.grants.includes(e.path) ? c : { ...c, grants: [...c.grants, e.path] };
    default:
      return c;
  }
}

// When a task ends, any consent card still "pending" can never be answered (the
// broker resolved it as a deny on abort/finish), so retire it to "cancelled".
function cancelPendingConsents(c: Conversation): Conversation {
  return {
    ...c,
    items: c.items.map((it) =>
      it.role === "assistant"
        ? {
            ...it,
            blocks: it.blocks.map((b) =>
              b.kind === "consent" && b.state === "pending"
                ? { ...b, state: "cancelled" as const }
                : b,
            ),
          }
        : it,
    ),
  };
}

// The user's answer to a consent prompt isn't an AgentEvent — the renderer
// applies it after calling respondConsent, to flip the card. It does NOT touch
// grants: the folder appears in the list only once main records it and emits
// `grant_added` (the normalized path), so the UI mirrors the authoritative store
// rather than optimistically echoing the raw requested path.
export function resolveConsent(
  c: Conversation,
  requestId: string,
  decision: "allow" | "deny",
): Conversation {
  return {
    ...c,
    items: c.items.map((it) =>
      it.role === "assistant"
        ? {
            ...it,
            blocks: it.blocks.map((b) =>
              b.kind === "consent" && b.id === requestId ? { ...b, state: decision } : b,
            ),
          }
        : it,
    ),
  };
}

// User messages aren't AgentEvents — the renderer adds them when a task is sent.
export function addUser(c: Conversation, text: string): Conversation {
  return { ...c, items: [...c.items, { id: `i${c.items.length}`, role: "user", text }] };
}

// The conversation's display title: the first thing the user asked.
export function conversationTitle(c: Conversation): string {
  const first = c.items.find((i) => i.role === "user");
  return first && first.role === "user" ? first.text : "New task";
}

// Tool-call counts by name, for the info pane (e.g. { Read: 2, Bash: 1 }).
export function toolCounts(c: Conversation): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of c.items) {
    if (it.role !== "assistant") continue;
    for (const b of it.blocks) {
      if (b.kind === "tool") counts[b.name] = (counts[b.name] ?? 0) + 1;
    }
  }
  return counts;
}
