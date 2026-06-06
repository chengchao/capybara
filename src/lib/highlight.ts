import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// highlight.js core + only the languages the agent realistically emits, so the
// bundle stays small. The token classes it produces (.hljs-keyword, -string, …)
// are styled in index.css against the app's theme tokens, so highlighting follows
// light/dark automatically.
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  css,
  diff,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

// Common fence aliases → registered language.
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "typescript",
  jsx: "typescript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  yml: "yaml",
  html: "xml",
  md: "markdown",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// Return highlighted HTML for `code` in `lang`. For a known language, highlight.js
// escapes the text and wraps tokens in safe spans. For an unknown/missing
// language we escape and return the plain text (no auto-detect — cheaper, and it
// avoids mislabeling). The output is always HTML-safe to inject.
export function highlightCode(code: string, lang?: string): string {
  const name = lang ? (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()) : "";
  if (name && hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch {
      // Fall through to plain escaping on any highlighter error.
    }
  }
  return escapeHtml(code);
}
