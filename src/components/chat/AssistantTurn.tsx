import type { AssistantItem } from "@/lib/transcript";

import { CapyMark } from "./CapyMark";
import { MarkdownText } from "./MarkdownText";
import { ToolCard } from "./ToolCard";

export function AssistantTurn({ item }: { item: AssistantItem }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-agent/40 bg-agent/10 text-agent">
        <CapyMark className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-xs font-semibold text-agent">Capybara</div>
        {item.blocks.map((b) =>
          b.kind === "text" ? (
            <MarkdownText key={b.id} text={b.text} />
          ) : (
            <ToolCard key={b.id} block={b} />
          ),
        )}
      </div>
    </div>
  );
}
