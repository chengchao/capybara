import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { requestDirectoryConsent } from "../consent";
import { commandResponseTimeoutMs, type SupervisorClient } from "../vm";
import { grantDirectory } from "./grants";

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

function asToolResult(result: RunResult): ToolResult {
  if (result.exitCode === 0) {
    return {
      content: [{ type: "text", text: result.stdout }],
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
// `init` message — which always precedes the first tool call. `getSdkSessionId`
// is the raw SDK session id (NOT the derived VM id `resolveSession` returns) —
// it keys the folder-grant store, the same value the PreToolUse hook reads.
//
// Only Bash routes through the VM. Read/Glob/Write are the SDK's built-in
// tools running natively in the agent subprocess on the host (enabled via
// `allowedTools` in runTask.ts), so they aren't defined here.
export function buildTools(
  supervisor: SupervisorClient,
  resolveSession: () => Promise<string>,
  getSdkSessionId: () => string,
) {
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

  // The host file tools (Read/Glob/Write/...) only reach directories the user
  // has connected; the PreToolUse hook denies anything else and tells the model
  // to call this. On Allow the grant is recorded and the retry passes the hook.
  const requestDirectory = tool(
    "request_capybara_directory",
    "Request access to a host directory so the file tools (Read, Glob, Write) can use it. Call this after a file tool is denied for a path that is not connected, then retry the file tool.",
    {
      path: z.string().describe("Absolute path to the host directory to request access to."),
    },
    async (args) => {
      const ok = await requestDirectoryConsent(args.path);
      if (!ok) {
        return {
          content: [{ type: "text", text: `User denied access to ${args.path}.` }],
          isError: true,
        };
      }
      grantDirectory(getSdkSessionId(), args.path);
      return {
        content: [
          { type: "text", text: `Granted access to ${args.path}. Retry your file operation.` },
        ],
      };
    },
  );

  return [bash, requestDirectory];
}
