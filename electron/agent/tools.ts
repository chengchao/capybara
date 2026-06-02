import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { commandResponseTimeoutMs, type SupervisorClient } from "../vm";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CWD = "/workspace";

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

async function runInSandbox(
  supervisor: SupervisorClient,
  sessionId: string,
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (await supervisor.request(
    "run_as_session",
    {
      session_id: sessionId,
      command,
      cwd: options.cwd ?? DEFAULT_CWD,
      timeout_ms: timeoutMs,
    },
    commandResponseTimeoutMs(timeoutMs),
  )) as RunResult;
}

function asToolResult(result: RunResult, emptyFallback = ""): ToolResult {
  if (result.exitCode === 0) {
    return {
      content: [{ type: "text", text: result.stdout || emptyFallback }],
    };
  }
  const parts = [`[exit ${result.exitCode}]`];
  if (result.stderr) parts.push(result.stderr);
  if (result.stdout) parts.push(result.stdout);
  return {
    content: [{ type: "text", text: parts.join("\n") }],
    isError: true,
  };
}

// `resolveSession` returns the VM sandbox session id for the current
// conversation, creating it on first use. It's a thunk (not a plain string)
// because for a new conversation the id isn't known until the SDK emits its
// `init` message — which always precedes the first tool call.
//
// Only Bash routes through the VM. Read/Glob/Write are the SDK's built-in
// tools running natively in the agent subprocess on the host (enabled via
// `allowedTools` in runTask.ts), so they aren't defined here.
export function buildTools(supervisor: SupervisorClient, resolveSession: () => Promise<string>) {
  const bash = tool(
    "Bash",
    "Execute a bash command inside the Capybara sandbox. Working directory defaults to /workspace; allowed cwd roots are /workspace, /home/capybara, /tmp, and /mnt. Use for any shell-shaped task.",
    {
      command: z.string().describe("The shell command to execute"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory inside the sandbox. Defaults to /workspace."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max execution time in milliseconds. Default 60000."),
    },
    async (args) => {
      const sessionId = await resolveSession();
      const result = await runInSandbox(supervisor, sessionId, args.command, {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
      });
      return asToolResult(result);
    },
  );

  return [bash];
}
