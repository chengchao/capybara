// A tiny, dependency-free markdown parser — pure functions so they're unit
// testable, with the rendering left to MarkdownText.tsx. Scope is what the
// agent actually emits: fenced code blocks, **bold**, and `inline code`.
//
// Note: single-asterisk *italic* is deliberately NOT supported. Agent prose
// routinely contains bare asterisks (glob patterns like `*.zip`, `**/*.py`),
// and an italic rule false-positives across them; bold + code cover the common
// cases without that hazard. (Richer markdown is a later polish PR.)

export type Inline =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code"; value: string };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ type: "text", value: text.slice(last, i) });
    const t = m[0];
    if (t.startsWith("**")) out.push({ type: "bold", value: t.slice(2, -2) });
    else out.push({ type: "code", value: t.slice(1, -1) });
    last = i + t.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

export type Segment = { code: boolean; value: string; lang?: string };

const FENCE_LANG = /^([a-zA-Z0-9+#._-]*)\n/;

// Split on ``` fences; odd segments are code. The opening fence's optional
// language tag is captured (for syntax highlighting) and, with a trailing
// newline, trimmed from the value. An unclosed fence renders its tail as code.
export function splitFences(text: string): Segment[] {
  return text.split("```").map((value, i) => {
    if (i % 2 === 0) return { code: false, value };
    const lang = value.match(FENCE_LANG)?.[1] || undefined;
    return { code: true, lang, value: value.replace(FENCE_LANG, "").replace(/\n$/, "") };
  });
}
