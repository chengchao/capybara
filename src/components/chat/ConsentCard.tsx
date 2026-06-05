import { Button } from "@/components/ui/button";
import type { ConsentBlock } from "@/lib/transcript";

import { useConsent } from "./consent-context";

export function ConsentCard({ block }: { block: ConsentBlock }) {
  const respond = useConsent();

  if (block.state !== "pending") {
    const allowed = block.state === "allow";
    return (
      <div
        className={`font-mono text-xs ${allowed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
      >
        {allowed ? "✓ Allowed " : "✕ Denied "}
        {block.path}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-agent/40 bg-agent/5 p-3">
      <div className="flex items-center gap-2 text-sm">
        <svg
          className="size-4 shrink-0 text-agent"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
        <span>
          Capybara wants to access <span className="font-mono text-agent">{block.path}</span>
        </span>
      </div>
      <p className="mt-1.5 mb-2.5 pl-6 text-xs text-muted-foreground">
        Read &amp; write · only for this conversation
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => respond(block.id, "deny")}
        >
          Deny
        </Button>
        <Button
          type="button"
          size="sm"
          className="flex-1"
          onClick={() => respond(block.id, "allow")}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}
