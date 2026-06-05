import { expect, test } from "bun:test";

import { parseInline, splitFences } from "./markdown";

test("plain text is a single text token", () => {
  expect(parseInline("just words")).toEqual([{ type: "text", value: "just words" }]);
});

test("bold and inline code are parsed; surrounding text is preserved", () => {
  expect(parseInline("a **b** and `c` end")).toEqual([
    { type: "text", value: "a " },
    { type: "bold", value: "b" },
    { type: "text", value: " and " },
    { type: "code", value: "c" },
    { type: "text", value: " end" },
  ]);
});

test("bare asterisks (glob patterns) are NOT treated as italic", () => {
  // The asterisk-italic hazard from review: this must stay one plain text token.
  expect(parseInline("unpack *.zip and *.tar archives")).toEqual([
    { type: "text", value: "unpack *.zip and *.tar archives" },
  ]);
});

test("a backticked glob is code, not mangled", () => {
  expect(parseInline("match `**/*.py` files")).toEqual([
    { type: "text", value: "match " },
    { type: "code", value: "**/*.py" },
    { type: "text", value: " files" },
  ]);
});

test("splitFences separates code from prose, capturing the lang and trimming it", () => {
  expect(splitFences("before ```js\nconst x = 1;\n``` after")).toEqual([
    { code: false, value: "before " },
    { code: true, lang: "js", value: "const x = 1;" },
    { code: false, value: " after" },
  ]);
});

test("splitFences leaves lang undefined for a bare fence", () => {
  expect(splitFences("```\nplain\n```")).toEqual([
    { code: false, value: "" },
    { code: true, lang: undefined, value: "plain" },
    { code: false, value: "" },
  ]);
});

test("text with no fence is one prose segment", () => {
  expect(splitFences("no code here")).toEqual([{ code: false, value: "no code here" }]);
});
