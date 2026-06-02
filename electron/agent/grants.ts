import os from "node:os";
import path from "node:path";

// Session-only, in-memory folder grants. Each conversation (keyed by SDK session
// id) holds the set of host directories the user has approved. One access level:
// a granted directory allows ANY gated file tool on paths inside it — read and
// write are not distinguished. Bounded by the app process lifetime; a new
// conversation gets a fresh (empty) key and re-asks.
const store = new Map<string, string[]>();

// Built-in host file tools we gate, mapped to the input field holding the target
// path. Bare names on purpose: built-ins arrive unprefixed, while our MCP tools
// (`Bash`, `request_capybara_directory`) arrive as `mcp__capybara__*` and so are
// absent here — the early return below lets them through ungated.
const GATED: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "path",
  Grep: "path",
};

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

// `+ path.sep` guard: `/foo/barbaz` must not match a grant of `/foo/bar`.
function within(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir + path.sep);
}

export function grantDirectory(sessionId: string, dir: string): void {
  const norm = normalize(dir);
  if (!norm) return;
  const dirs = store.get(sessionId) ?? [];
  if (!dirs.includes(norm)) dirs.push(norm);
  store.set(sessionId, dirs);
}

export function evaluateFileTool(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
): { allow: true } | { deny: true; reason: string } {
  const field = GATED[toolName];
  if (!field) return { allow: true };

  const raw = (toolInput as Record<string, unknown> | null | undefined)?.[field];
  const candidate = normalize(raw);
  if (!candidate) {
    return {
      deny: true,
      reason: `${toolName} needs an absolute "${field}". Provide an absolute path under a connected directory, or call request_capybara_directory({ path: "<absolute dir>" }) to request access, then retry.`,
    };
  }

  const dirs = store.get(sessionId) ?? [];
  if (dirs.some((d) => within(candidate, d))) return { allow: true };

  // Suggest granting the containing directory (dirname for a file target; the
  // path itself for a Glob/Grep directory target).
  const suggested = field === "file_path" ? path.dirname(candidate) : candidate;
  return {
    deny: true,
    reason: `Path "${candidate}" is not connected. Call request_capybara_directory({ path: "${suggested}" }) to request access, then retry.`,
  };
}
