import os from "node:os";
import path from "node:path";

// Session-only, in-memory folder grants. Each conversation (keyed by SDK session
// id) holds the set of host directories the user has approved. One access level:
// a granted directory allows ANY gated file tool on paths inside it — read and
// write are not distinguished. Bounded by the app process lifetime; a new
// conversation gets a fresh (empty) key and re-asks.
const store = new Map<string, string[]>();

// Host file built-ins we gate, mapped to the input field holding the target
// path. Deliberately a SUPERSET of what runTask exposes (see BUILTIN_TOOLS): the
// availability allowlist and this path-gate are independent layers, so any host
// tool later added to BUILTIN_TOOLS is already gated here — no whack-a-mole.
// Bare names: built-ins arrive unprefixed; our MCP tools (`Bash`,
// `request_capybara_directory`) arrive as `mcp__capybara__*` and so are absent
// here — the early return lets them through.
const GATED: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "path",
  Grep: "path",
  NotebookEdit: "notebook_path",
};

// Glob/Grep resolve `pattern` relative to the gated `path`, so a pattern can walk
// out of a connected directory even when `path` is inside one. Their patterns
// must stay relative and `..`-free.
const PATTERN_TOOLS = new Set(["Glob", "Grep"]);

// Expand a leading `~`, require an absolute path, collapse `..`. Returns null for
// a falsy or non-absolute input (the model is instructed to use absolute paths).
// Symlink/realpath resolution is deferred: a symlink under a granted dir that
// points elsewhere still passes. Documented trust-boundary gap, not an oversight.
function normalize(p: unknown): string | null {
  if (typeof p !== "string" || p === "") return null;
  const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
}

// `+ path.sep` guard: `/foo/barbaz` must not match a grant of `/foo/bar`. The
// root grant `/` already ends in a separator, so don't double it.
function within(candidate: string, dir: string): boolean {
  if (candidate === dir) return true;
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return candidate.startsWith(prefix);
}

// A Glob/Grep pattern reaches outside its search root if it — or any brace
// alternative — is absolute or contains a `..` segment. Braces concatenate with
// surrounding text, so `{..,x}/y` → `../y` and `{/etc,x}/*` → `/etc/*` must be
// caught, not just a leading `/` or top-level `..`. We treat `{ } ,` as
// alternative boundaries: flag an absolute branch (a separator at string start
// or right after `{`/`,`) or a `..` token in any branch. Conservative by design
// — a contrived pattern like `a{..,b}c` is rejected though it wouldn't actually
// escape — because over-deny is the safe direction.
function patternEscapes(pattern: unknown): boolean {
  if (typeof pattern !== "string") return false;
  if (/(^|[{,])[/\\]/.test(pattern)) return true;
  return pattern.split(/[/\\{},]/).includes("..");
}

// Returns true if the grant was stored. False means the path wasn't an absolute
// directory and nothing was recorded — the caller must not claim success.
export function grantDirectory(sessionId: string, dir: string): boolean {
  const norm = normalize(dir);
  if (!norm) return false;
  const dirs = store.get(sessionId) ?? [];
  if (!dirs.includes(norm)) dirs.push(norm);
  store.set(sessionId, dirs);
  return true;
}

export function evaluateFileTool(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
): { allow: true } | { deny: true; reason: string } {
  const field = GATED[toolName];
  if (!field) return { allow: true };

  const input = (toolInput ?? {}) as Record<string, unknown>;
  const candidate = normalize(input[field]);
  if (!candidate) {
    return {
      deny: true,
      reason: `${toolName} needs an absolute "${field}". Provide an absolute path under a connected directory, or call request_capybara_directory({ path: "<absolute dir>" }) to request access, then retry.`,
    };
  }

  const dirs = store.get(sessionId) ?? [];
  if (!dirs.some((d) => within(candidate, d))) {
    // Suggest granting the containing directory (dirname for a file target; the
    // path itself for a Glob/Grep directory target).
    const suggested = field === "path" ? candidate : path.dirname(candidate);
    return {
      deny: true,
      reason: `Path "${candidate}" is not connected. Call request_capybara_directory({ path: "${suggested}" }) to request access, then retry.`,
    };
  }

  if (PATTERN_TOOLS.has(toolName) && patternEscapes(input.pattern)) {
    return {
      deny: true,
      reason: `${toolName} pattern "${String(input.pattern)}" may reach outside the connected directory "${candidate}". Use a pattern relative to it, with no leading "/" and no "..".`,
    };
  }

  return { allow: true };
}
