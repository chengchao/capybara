import { expect, test } from "bun:test";

import { ALLOWED_TOOLS, TOOL_PREFIX } from "./allowedTools";

// The VM-only-shell guarantee rests entirely on this list: Bash must be the
// MCP-prefixed tool (which routes into the sandbox), and the SDK's built-in
// host `Bash` must never appear bare (the SDK auto-runs allow-listed tools, so
// a bare "Bash" would let the model run a shell on the host, escaping the VM).
test("only the VM-routed Bash is allowed; host shell stays out", () => {
  expect(ALLOWED_TOOLS).toContain(`${TOOL_PREFIX}Bash`);
  expect(ALLOWED_TOOLS).not.toContain("Bash");
});
