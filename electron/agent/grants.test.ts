import { beforeEach, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { evaluateFileTool, grantDirectory } from "./grants";

// Each test uses a unique session id so the module-level store stays isolated
// without a reset hook. A counter keeps them distinct across this file.
let n = 0;
let S = "";
beforeEach(() => {
  n += 1;
  S = `sess-${n}`;
});

const read = (p: string) => evaluateFileTool(S, "Read", { file_path: p });
const write = (p: string) => evaluateFileTool(S, "Write", { file_path: p });
const glob = (p?: string) => evaluateFileTool(S, "Glob", p === undefined ? {} : { path: p });
const globP = (p: string, pattern: string) => evaluateFileTool(S, "Glob", { path: p, pattern });
const notebook = (p: string) => evaluateFileTool(S, "NotebookEdit", { notebook_path: p });

test("ungranted path is denied with an actionable reason", () => {
  const r = read("/Users/x/Desktop/a.txt");
  expect(r).toMatchObject({ deny: true });
  if ("deny" in r) {
    expect(r.reason).toContain("/Users/x/Desktop/a.txt");
    expect(r.reason).toContain("request_capybara_directory");
    // suggests the containing directory for a file target
    expect(r.reason).toContain(`path: "/Users/x/Desktop"`);
  }
});

test("a single grant covers both a read tool and a write tool", () => {
  grantDirectory(S, "/Users/x/proj");
  expect(read("/Users/x/proj/a.txt")).toEqual({ allow: true });
  expect(write("/Users/x/proj/sub/b.txt")).toEqual({ allow: true });
});

test("subpaths are allowed; the directory itself is allowed", () => {
  grantDirectory(S, "/data");
  expect(glob("/data")).toEqual({ allow: true });
  expect(read("/data/deep/nested/x")).toEqual({ allow: true });
});

test("prefix spoof is denied (/foo/barbaz not under /foo/bar)", () => {
  grantDirectory(S, "/foo/bar");
  expect(read("/foo/barbaz/x")).toMatchObject({ deny: true });
  expect(read("/foo/bar/x")).toEqual({ allow: true });
});

test("a leading ~ expands to the home directory", () => {
  grantDirectory(S, "~/Documents");
  expect(read(path.join(os.homedir(), "Documents", "note.md"))).toEqual({ allow: true });
  expect(read("~/Documents/note.md")).toEqual({ allow: true });
});

test("relative or missing paths are denied", () => {
  grantDirectory(S, "/data");
  expect(read("relative/path.txt")).toMatchObject({ deny: true });
  expect(glob(undefined)).toMatchObject({ deny: true });
});

test("grants are isolated per session", () => {
  grantDirectory(S, "/data");
  expect(read("/data/x")).toEqual({ allow: true });
  expect(evaluateFileTool("other-session", "Read", { file_path: "/data/x" })).toMatchObject({
    deny: true,
  });
});

test("non-gated tools (MCP, consent) are never gated", () => {
  expect(evaluateFileTool(S, "mcp__capybara__Bash", { command: "ls" })).toEqual({ allow: true });
  expect(
    evaluateFileTool(S, "mcp__capybara__request_capybara_directory", { path: "/anything" }),
  ).toEqual({ allow: true });
});

test("a Glob pattern cannot escape the granted path", () => {
  grantDirectory(S, "/data");
  expect(globP("/data", "**/*.txt")).toEqual({ allow: true });
  expect(globP("/data", "../etc/*")).toMatchObject({ deny: true });
  expect(globP("/data", "/etc/**")).toMatchObject({ deny: true });
});

test("brace expansion cannot smuggle a traversal past the pattern check", () => {
  grantDirectory(S, "/data");
  // Legitimate braces still work.
  expect(globP("/data", "**/*.{js,ts}")).toEqual({ allow: true });
  expect(globP("/data", "{src,test}/**")).toEqual({ allow: true });
  // A `..` or absolute branch hidden in a brace is rejected.
  expect(globP("/data", "{..,x}/secret/*")).toMatchObject({ deny: true });
  expect(globP("/data", "{/etc,x}/*")).toMatchObject({ deny: true });
  expect(globP("/data", "a/{..,y}/z")).toMatchObject({ deny: true });
});

test("NotebookEdit is gated on its notebook_path", () => {
  grantDirectory(S, "/data");
  expect(notebook("/data/x.ipynb")).toEqual({ allow: true });
  expect(notebook("/other/x.ipynb")).toMatchObject({ deny: true });
});

test("granting the filesystem root covers all subpaths", () => {
  grantDirectory(S, "/");
  expect(read("/anything/deep/x")).toEqual({ allow: true });
});

test("grantDirectory reports whether it stored a grant", () => {
  expect(grantDirectory(S, "/abs/dir")).toBe(true);
  expect(grantDirectory(S, "relative/dir")).toBe(false);
  expect(grantDirectory(S, "")).toBe(false);
});
