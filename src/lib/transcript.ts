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
export type Block = TextBlock | ToolBlock;

export type ServiceItem = { id: string; role: "service"; text: string };
export type UserItem = { id: string; role: "user"; text: string };
export type AssistantItem = { id: string; role: "assistant"; blocks: Block[] };
export type Item = ServiceItem | UserItem | AssistantItem;

export type Conversation = {
  sessionId: string | null;
  status: "idle" | "running" | "done";
  items: Item[];
};

export function emptyConversation(): Conversation {
  return { sessionId: null, status: "idle", items: [] };
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
      return { ...c, status: "running" };
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
      return { ...c, status: "done" };
    default:
      return c;
  }
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
