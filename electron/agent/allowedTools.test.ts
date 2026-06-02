import { expect, test } from "bun:test";

import { ALLOWED_TOOLS, DISALLOWED_TOOLS, TOOL_PREFIX } from "./allowedTools";

// The VM-only-shell guarantee has two halves: the shell the model is allowed to
// use must be the MCP-prefixed one (which routes into the sandbox), and the
// SDK's built-in host `Bash` must be explicitly disallowed. Allow-listing alone
// is not enough — built-in tools stay available unless named in disallowedTools
// (verified by running the app: without this the built-in Bash runs on the
// host). Both halves are asserted here so a regression in either fails.
test("the only usable shell is the VM-routed Bash", () => {
  expect(ALLOWED_TOOLS).toContain(`${TOOL_PREFIX}Bash`);
  expect(ALLOWED_TOOLS).not.toContain("Bash");
  expect(DISALLOWED_TOOLS).toContain("Bash");
});
