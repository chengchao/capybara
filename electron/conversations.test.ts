import { expect, test } from "bun:test";

import { isSafeId, sanitizeOne } from "./conversations";

test("a persisted running status is settled to done with no taskId", () => {
  expect(sanitizeOne({ id: "a", status: "running", taskId: "t1" })).toMatchObject({
    id: "a",
    status: "done",
    taskId: null,
  });
});

test("a done conversation passes through untouched", () => {
  const done = { id: "a", status: "done", taskId: null, items: [] };
  expect(sanitizeOne(done)).toEqual(done);
});

test("a non-object sanitizes to null", () => {
  expect(sanitizeOne(null)).toBeNull();
  expect(sanitizeOne("oops")).toBeNull();
  expect(sanitizeOne(42)).toBeNull();
});

test("isSafeId accepts uuids/slugs and rejects path-ish or empty ids", () => {
  expect(isSafeId("3f9a12bc-uuid_ABC")).toBe(true);
  expect(isSafeId("../../etc/passwd")).toBe(false);
  expect(isSafeId("a/b")).toBe(false);
  expect(isSafeId("a.json")).toBe(false);
  expect(isSafeId("")).toBe(false);
  expect(isSafeId(123)).toBe(false);
});
