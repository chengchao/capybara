import type { Conversation } from "@/lib/transcript";
import { conversationTitle } from "@/lib/transcript";
import type { VmStatus } from "@/lib/vm";

import { CapyMark } from "./CapyMark";

function statusLine(c: Conversation): string {
  if (c.status === "running") return "working…";
  if (c.items.length > 0) return "finished";
  return "new";
}

export function Sidebar({
  conversations,
  currentId,
  vm,
  busy,
  onSelect,
  onNewTask,
}: {
  conversations: Conversation[];
  currentId: string;
  vm: VmStatus;
  busy: boolean; // a task is running somewhere → block starting another
  onSelect: (id: string) => void;
  onNewTask: () => void;
}) {
  return (
    <aside className="flex h-full flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-agent/15 text-agent">
          <CapyMark className="size-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Capybara</div>
          <div className="font-mono text-[10px] text-muted-foreground">office-work agent</div>
        </div>
      </div>

      <button
        type="button"
        onClick={onNewTask}
        disabled={busy}
        title={busy ? "Stop the running task first" : undefined}
        className="mx-3 mb-3 flex h-9 items-center gap-2 rounded-md border border-agent/40 bg-agent/10 px-3 text-sm font-medium text-agent hover:bg-agent/15 disabled:pointer-events-none disabled:opacity-50"
      >
        <span className="text-base leading-none">+</span> New task
      </button>

      <div className="px-4 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        Recent
      </div>
      <div className="flex-1 overflow-auto px-2">
        {conversations.map((c) => {
          const active = c.id === currentId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={`mb-0.5 block w-full rounded-md px-3 py-2 text-left ${
                active ? "bg-agent/10" : "hover:bg-muted"
              }`}
            >
              <div
                className={`truncate text-sm font-medium ${active ? "text-agent" : "text-foreground"}`}
              >
                {conversationTitle(c)}
              </div>
              <div className="text-xs text-muted-foreground">{statusLine(c)}</div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span
          className={`size-1.5 rounded-full ${
            vm.kind === "running"
              ? "bg-emerald-500"
              : vm.kind === "failed"
                ? "bg-destructive"
                : "bg-agent"
          }`}
        />
        VM {vm.kind === "running" ? "ready" : vm.kind === "failed" ? "failed" : "starting…"}
      </div>
    </aside>
  );
}
