export const TOOL_PREFIX = "mcp__capybara__";

// Bash routes through our in-process MCP server into the VM sandbox; Read,
// Glob, and Write are the SDK's built-in tools running natively on the host;
// request_capybara_directory is the MCP consent tool the model calls to unlock
// a host folder after the PreToolUse hook denies it.
export const ALLOWED_TOOLS = [
  TOOL_PREFIX + "Bash",
  TOOL_PREFIX + "request_capybara_directory",
  "Read",
  "Glob",
  "Write",
];

// `allowedTools` only auto-approves — it does NOT restrict which tools exist.
// The SDK's built-in `Bash` stays available (and the claude binary auto-runs it
// under its own cwd guardrail) unless we explicitly disallow it. Without this
// the model runs a shell on the host, never reaching `mcp__capybara__Bash` or
// the VM. Verified by running the app: dropping this lets `uname -s` return the
// host's `Darwin` with zero `run_as_session` calls to the supervisor.
export const DISALLOWED_TOOLS = ["Bash"];
