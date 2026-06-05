import { useState } from "react";

import type { Origin, ToolBlock } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// One-line summary of a tool call, shown in the collapsed header.
function summarize(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "Bash") return str(o.command);
  if (o.file_path) return str(o.file_path);
  if (o.pattern) return str(o.pattern) + (o.path ? ` in ${str(o.path)}` : "");
  if (o.path) return str(o.path);
  return "";
}

// tool_result content may be a string or the SDK's `[{ type:"text", text }]`.
function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((b) =>
        b && typeof b === "object" && "text" in b
          ? String((b as { text: unknown }).text)
          : JSON.stringify(b),
      )
      .join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function Spinner({ origin }: { origin: Origin }) {
  return (
    <span
      className={cn(
        "inline-block size-3 animate-spin rounded-full border-2",
        origin === "vm" ? "border-vm/30 border-t-vm" : "border-host/30 border-t-host",
      )}
    />
  );
}

function Status({ block }: { block: ToolBlock }) {
  if (block.status === "running") {
    return (
      <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <Spinner origin={block.origin} />
        running
      </span>
    );
  }
  if (block.status === "error")
    return <span className="font-mono text-xs text-destructive">✕ error</span>;
  return <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">✓ done</span>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <pre className="overflow-x-auto break-words whitespace-pre-wrap text-muted-foreground">
        {value}
      </pre>
    </div>
  );
}

export function ToolCard({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const isVm = block.origin === "vm";
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
      >
        <span
          className={cn(
            "text-[10px] text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        >
          ▶
        </span>
        <span className="font-mono text-xs font-semibold">{block.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {summarize(block.name, block.input)}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold",
            isVm ? "bg-vm/15 text-vm" : "bg-host/15 text-host",
          )}
        >
          {isVm ? "VM" : "HOST"}
        </span>
        <Status block={block} />
      </button>
      {open && (
        <div className="space-y-2 border-t bg-muted/40 px-3 py-2 font-mono text-xs">
          <Field label="input" value={JSON.stringify(block.input)} />
          {block.result !== undefined && <Field label="output" value={resultText(block.result)} />}
        </div>
      )}
    </div>
  );
}
