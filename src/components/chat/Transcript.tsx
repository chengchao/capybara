import { useEffect, useRef } from "react";

import type { Conversation } from "@/lib/transcript";

import { AssistantTurn } from "./AssistantTurn";

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
        {text}
      </div>
    </div>
  );
}

function ServiceMessage({ text }: { text: string }) {
  return (
    <div className="text-center">
      <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{text}</span>
    </div>
  );
}

function Working() {
  return (
    <div className="flex items-center gap-2 pl-10 text-sm text-muted-foreground">
      Capybara is working
      <span className="flex gap-1">
        <span className="size-1.5 animate-bounce rounded-full bg-agent [animation-delay:0ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-agent [animation-delay:150ms]" />
        <span className="size-1.5 animate-bounce rounded-full bg-agent [animation-delay:300ms]" />
      </span>
    </div>
  );
}

export function Transcript({ conversation }: { conversation: Conversation }) {
  const ref = useRef<HTMLDivElement>(null);
  // Stick to the bottom as events stream in, but not if the user has scrolled
  // up to read earlier output. (A jump-to-latest affordance is a later PR.)
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [conversation.items, conversation.status]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (conversation.items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Nothing yet — describe a task below and Capybara will get to work.
      </div>
    );
  }

  return (
    <div ref={ref} onScroll={onScroll} className="h-full overflow-auto px-5 py-5 text-left">
      <div className="mx-auto max-w-3xl space-y-4">
        {conversation.items.map((it) => {
          if (it.role === "user") return <UserMessage key={it.id} text={it.text} />;
          if (it.role === "service") return <ServiceMessage key={it.id} text={it.text} />;
          return <AssistantTurn key={it.id} item={it} />;
        })}
        {conversation.status === "running" && <Working />}
      </div>
    </div>
  );
}
