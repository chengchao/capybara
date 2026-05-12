import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SupervisorClient } from "./supervisor";

export const SESSION_ID = "agent_default";
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
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return (await supervisor.request("run_as_session", {
    session_id: SESSION_ID,
    command,
    cwd: options.cwd ?? DEFAULT_CWD,
    timeout_ms: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })) as RunResult;
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

// Single-quote escaping for embedding user-supplied strings into bash via
// `'...'`. Bash treats everything inside single quotes literally except a
// single quote itself; the standard trick is to close, insert an escaped
// quote, and reopen.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildTools(supervisor: SupervisorClient) {
  const bash = tool(
    "Bash",
    "Execute a bash command inside the Capybara sandbox. The working directory defaults to /workspace; allowed cwd roots are /workspace, /home/capybara, /tmp, and /mnt. Use this for any shell-shaped task: running scripts, inspecting files, invoking package managers, etc.",
    {
      command: z.string().describe("The shell command to execute"),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory inside the sandbox. Defaults to /workspace.",
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max execution time in milliseconds. Default 60000."),
    },
    async (args) => {
      const result = await runInSandbox(supervisor, args.command, {
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
      file_path: z
        .string()
        .describe("Absolute path to the file inside the sandbox."),
    },
    async (args) => {
      const result = await runInSandbox(
        supervisor,
        `cat -- ${shellQuote(args.file_path)}`,
      );
      return asToolResult(result, "(empty file)");
    },
  );

  const glob = tool(
    "Glob",
    "Find files matching a glob pattern inside the Capybara sandbox. Returns matching paths, one per line. Supports `**` for recursive matching.",
    {
      pattern: z
        .string()
        .describe("Glob pattern (e.g. **/*.py or src/*.ts)."),
      path: z
        .string()
        .optional()
        .describe(
          "Directory to search under (must be inside the sandbox). Defaults to /workspace.",
        ),
    },
    async (args) => {
      const root = args.path ?? "/workspace";
      // bash globstar + nullglob: `**` matches recursively, no-match expands
      // to nothing instead of literal pattern text.
      const cmd = `shopt -s globstar nullglob; cd ${shellQuote(root)} && for f in ${args.pattern}; do printf "%s\\n" "$f"; done`;
      const result = await runInSandbox(supervisor, cmd);
      return asToolResult(result, "(no matches)");
    },
  );

  return [bash, read, glob];
}
