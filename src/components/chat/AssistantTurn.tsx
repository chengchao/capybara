import { memo } from "react";

import type { AssistantItem } from "@/lib/transcript";

import { CapyMark } from "./CapyMark";
import { ConsentCard } from "./ConsentCard";
import { MarkdownText } from "./MarkdownText";
import { ToolCard } from "./ToolCard";

// Memoized: every streaming event replaces the conversation, but applyEvent keeps
// unchanged items referentially stable, so finished turns skip re-render — and so
// avoid re-running syntax highlighting over their (unchanged) code blocks. Only
// the in-flight turn, whose item reference actually changes, re-renders.
export const AssistantTurn = memo(function AssistantTurn({ item }: { item: AssistantItem }) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-agent/40 bg-agent/10 text-agent">
        <CapyMark className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-xs font-semibold text-agent">Capybara</div>
        {item.blocks.map((b) => {
          if (b.kind === "text") return <MarkdownText key={b.id} text={b.text} />;
          if (b.kind === "tool") return <ToolCard key={b.id} block={b} />;
          return <ConsentCard key={b.id} block={b} />;
        })}
      </div>
    </div>
  );
});
