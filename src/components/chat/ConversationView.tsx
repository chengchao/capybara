import type { Conversation } from "@/lib/transcript";
import { conversationTitle } from "@/lib/transcript";

import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

export function ConversationView({
  conversation,
  running,
  error,
  infoOpen,
  onToggleInfo,
  onSend,
  onStop,
}: {
  conversation: Conversation;
  running: boolean;
  error: string;
  infoOpen: boolean;
  onToggleInfo: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const subtitle = running ? "running…" : conversation.items.length > 0 ? "finished" : "ready";
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-13 flex-none items-center gap-3 border-b px-5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{conversationTitle(conversation)}</div>
          <div className="font-mono text-[11px] text-muted-foreground">{subtitle}</div>
        </div>
        <button
          type="button"
          aria-label="Toggle info"
          aria-pressed={infoOpen}
          onClick={onToggleInfo}
          className="ml-auto flex size-8 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground aria-pressed:border-agent/40 aria-pressed:bg-agent/10 aria-pressed:text-agent"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1">
        <Transcript conversation={conversation} />
      </div>

      {error && (
        <div className="mx-auto w-full max-w-3xl px-5 pb-1">
          <pre className="rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs break-words whitespace-pre-wrap text-destructive">
            {error}
          </pre>
        </div>
      )}

      <Composer running={running} onSend={onSend} onStop={onStop} />
    </section>
  );
}
