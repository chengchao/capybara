import { useState } from "react";

import { Button } from "@/components/ui/button";

export function Composer({
  running,
  onSend,
}: {
  running: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function submit() {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    onSend(text);
  }

  return (
    <div className="border-t px-5 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border bg-card px-3 py-2 focus-within:border-ring">
          <textarea
            rows={1}
            value={draft}
            placeholder="Message Capybara…"
            disabled={running}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none disabled:opacity-60"
          />
          <Button
            type="button"
            size="icon"
            aria-label="Send"
            disabled={running || draft.trim() === ""}
            onClick={submit}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </Button>
        </div>
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {running ? (
            "Capybara is working…"
          ) : (
            <>
              <span className="font-medium text-foreground">Enter</span> to send ·{" "}
              <span className="font-medium text-foreground">Shift+Enter</span> for a newline
            </>
          )}
        </div>
      </div>
    </div>
  );
}
