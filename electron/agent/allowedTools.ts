export const TOOL_PREFIX = "mcp__capybara__";

// Bash routes through our in-process MCP server into the VM sandbox; Read,
// Glob, and Write are the SDK's built-in tools running natively on the host.
// Keeping the built-in `Bash` out of this list is what stops the model from
// running a shell on the host and bypassing the VM — see allowedTools.test.ts.
export const ALLOWED_TOOLS = [TOOL_PREFIX + "Bash", "Read", "Glob", "Write"];
