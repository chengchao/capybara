import { expect, test } from "bun:test";

import { isSafeId } from "./conversations";

// Shape validation + the stale-"running" repair now live with the schema in the
// renderer (src/lib/transcript.ts, parseStoredConversation) and are tested there.
// Here we cover the filename-safety guard that keeps a crafted id from escaping
// the conversations directory.
test("isSafeId accepts uuids/slugs and rejects path-ish or empty ids", () => {
  expect(isSafeId("3f9a12bc-uuid_ABC")).toBe(true);
  expect(isSafeId(crypto.randomUUID())).toBe(true);
  expect(isSafeId("../../etc/passwd")).toBe(false);
  expect(isSafeId("a/b")).toBe(false);
  expect(isSafeId("a.json")).toBe(false);
  expect(isSafeId("")).toBe(false);
  expect(isSafeId(123)).toBe(false);
  expect(isSafeId(null)).toBe(false);
});
