import * as React from "react";

import { parseInline, splitFences } from "@/lib/markdown";

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
          <pre
            key={i}
            className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs"
          >
            <code>{seg.value}</code>
          </pre>
        ) : (
          <Prose key={i} text={seg.value} />
        ),
      )}
    </div>
  );
}
