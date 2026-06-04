import * as React from "react";

// A small, dependency-free markdown renderer — enough for what the agent emits:
// fenced code blocks, bullet lists, and inline **bold** / *italic* / `code`.
// (Richer rendering — react-markdown + syntax highlight — is a later polish PR.)

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const t = m[0];
    if (t.startsWith("**")) {
      out.push(<strong key={key++}>{t.slice(2, -2)}</strong>);
    } else if (t.startsWith("`")) {
      out.push(
        <code key={key++} className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
          {t.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(<em key={key++}>{t.slice(1, -1)}</em>);
    }
    last = i + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
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
                <li key={j}>{inline(l.slice(2))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

export function MarkdownText({ text }: { text: string }) {
  const segments = text.split("```");
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {segments.map((seg, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className="overflow-x-auto rounded-md border bg-muted/60 p-3 font-mono text-xs"
          >
            <code>{seg.replace(/^[a-zA-Z]*\n/, "").replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <Prose key={i} text={seg} />
        ),
      )}
    </div>
  );
}
