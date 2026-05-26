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

// Bash single-quote escape: close the quote, insert escaped quote, reopen.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// `resolveSession` returns the VM sandbox session id for the current
// conversation, creating it on first use. It's a thunk (not a plain string)
// because for a new conversation the id isn't known until the SDK emits its
// `init` message — which always precedes the first tool call.
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

  const read = tool(
    "Read",
    "Read the contents of a file inside the Capybara sandbox. Returns the file's text.",
    {
      file_path: z.string().describe("Absolute path to the file inside the sandbox."),
    },
    async (args) => {
      const sessionId = await resolveSession();
      const result = await runInSandbox(
        supervisor,
        sessionId,
        `cat -- ${shellQuote(args.file_path)}`,
      );
      return asToolResult(result, "(empty file)");
    },
  );

  const glob = tool(
    "Glob",
    "Find files matching a glob pattern inside the Capybara sandbox. Returns matching paths, one per line. Supports `**` for recursive matching.",
    {
      pattern: z.string().describe("Glob pattern (e.g. **/*.py or src/*.ts)."),
      path: z
        .string()
        .optional()
        .describe(
          "Directory to search under (must be inside the sandbox). Defaults to /workspace.",
        ),
    },
    async (args) => {
      const sessionId = await resolveSession();
      const root = args.path ?? "/workspace";
      // bash globstar + nullglob: `**` matches recursively, no-match expands
      // to nothing instead of literal pattern text.
      const cmd = `shopt -s globstar nullglob; cd ${shellQuote(root)} && for f in ${args.pattern}; do printf "%s\\n" "$f"; done`;
      const result = await runInSandbox(supervisor, sessionId, cmd);
      return asToolResult(result, "(no matches)");
    },
  );

  return [bash, read, glob];
}
