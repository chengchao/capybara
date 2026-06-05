import { expect, test } from "bun:test";

import { sanitizeStored } from "./conversations";

test("a persisted running status is settled to done with no taskId", () => {
  const out = sanitizeStored([{ id: "a", status: "running", taskId: "t1" }]);
  expect(out[0]).toMatchObject({ id: "a", status: "done", taskId: null });
});

test("a done conversation passes through untouched", () => {
  const done = { id: "a", status: "done", taskId: null, items: [] };
  expect(sanitizeStored([done])[0]).toEqual(done);
});

test("a non-array payload sanitizes to an empty list", () => {
  expect(sanitizeStored({ nope: true })).toEqual([]);
  expect(sanitizeStored(null)).toEqual([]);
  expect(sanitizeStored("oops")).toEqual([]);
});

test("an empty array stays empty", () => {
  expect(sanitizeStored([])).toEqual([]);
});
