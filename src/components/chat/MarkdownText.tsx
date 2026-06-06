import { CheckIcon, CopyIcon } from "lucide-react";
import * as React from "react";

import { highlightCode } from "@/lib/highlight";
import { parseInline, splitFences } from "@/lib/markdown";

// A fenced code block: syntax-highlighted (theme-aware via the .hljs token CSS in
// index.css) with a hover copy button. `highlightCode` always returns HTML-safe
// output — highlight.js escapes the code text, and the no-language fallback
// escapes too — so injecting it is safe (the only dangerouslySetInnerHTML here).
function CodeBlock({ value, lang }: { value: string; lang?: string }) {
  const [copied, setCopied] = React.useState(false);
  const html = React.useMemo(() => highlightCode(value, lang), [value, lang]);
  // Track the "Copied ✓" reset timer so it's cleared on unmount (the block can be
  // replaced mid-stream) and never fires setState on a gone component.
  const resetTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (denied permission); leave the button as-is.
    }
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute top-2 right-2 rounded-md border bg-card/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
      <pre className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs">
        <code className="hljs bg-transparent p-0" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function Inlines({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((tok, i) => {
        if (tok.type === "bold") return <strong key={i}>{tok.value}</strong>;
        if (tok.type === "code") {
          return (
            <code key={i} className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
              {tok.value}
            </code>
          );
        }
        return <React.Fragment key={i}>{tok.value}</React.Fragment>;
      })}
    </>
  );
}

function Prose({ text }: { text: string }) {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      {paras.map((p, i) => {
        const lines = p.split("\n");
        if (lines.every((l) => l.startsWith("- "))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>
                  <Inlines text={l.slice(2)} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                <Inlines text={l} />
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {splitFences(text).map((seg, i) =>
        seg.code ? (
          <CodeBlock key={i} value={seg.value} lang={seg.lang} />
        ) : (
          <Prose key={i} text={seg.value} />
        ),
      )}
    </div>
  );
}
