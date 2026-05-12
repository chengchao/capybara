import {
  createSdkMcpServer,
  query,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { getSupervisor } from "../vm";
import { buildTools, SESSION_ID } from "./tools";

const requireFn = createRequire(__filename);

const TOOL_PREFIX = "mcp__capybara__";
const ALLOWED_TOOLS = ["Bash", "Read", "Glob"].map((name) => TOOL_PREFIX + name);

const MODEL = process.env.CAPYBARA_AGENT_MODEL ?? "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Capybara, an office-work agent. Your tools (Bash, Read, Glob) execute inside a Lima VM sandbox; the working directory is /workspace, and connected host directories appear at /mnt/<name>. You cannot run commands on the host directly — everything routes through the sandbox.`;

export type AgentEvent =
  | { event: "task_started"; taskId: string }
  | { event: "assistant_message"; taskId: string; text: string }
  | {
      event: "tool_use";
      taskId: string;
      tool: string;
      input: unknown;
      toolUseId: string;
    }
  | {
      event: "tool_result";
      taskId: string;
      toolUseId: string;
      content: unknown;
      isError: boolean;
    }
  | { event: "task_finished"; taskId: string };

type AgentEventEmitter = (event: AgentEvent) => void;

let cachedMcpServer: ReturnType<typeof createSdkMcpServer> | null = null;

function ensureSessionAndMcp() {
  if (cachedMcpServer) return cachedMcpServer;
  const supervisor = getSupervisor();
  cachedMcpServer = createSdkMcpServer({
    name: "capybara",
    tools: buildTools(supervisor),
  });
  return cachedMcpServer;
}

// SDK's cli.js lives inside its package; in production builds the package is
// under `app.asar.unpacked` (asarUnpack), not `app.asar`. Rewrite the path.
// Per anthropics/claude-agent-sdk-typescript#150.
function resolveClaudeCli(): string {
  const cliPath = requireFn.resolve("@anthropic-ai/claude-agent-sdk/cli.js");
  if (cliPath.includes("app.asar")) {
    const unpackedPath = cliPath.replace("app.asar", "app.asar.unpacked");
    if (existsSync(unpackedPath)) return unpackedPath;
  }
  return cliPath;
}

function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function relay(taskId: string, message: unknown, emit: AgentEventEmitter) {
  const msg = message as {
    type?: string;
    message?: { content?: unknown[] };
  };
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const raw of msg.message.content) {
      const block = raw as {
        type?: string;
        text?: string;
        name?: string;
        input?: unknown;
        id?: string;
      };
      if (block.type === "text" && typeof block.text === "string") {
        emit({ event: "assistant_message", taskId, text: block.text });
      } else if (block.type === "tool_use") {
        emit({
          event: "tool_use",
          taskId,
          tool: stripToolPrefix(block.name ?? ""),
          input: block.input,
          toolUseId: block.id ?? "",
        });
      }
    }
    return;
  }
  if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const raw of msg.message.content) {
      const block = raw as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      };
      if (block.type === "tool_result") {
        emit({
          event: "tool_result",
          taskId,
          toolUseId: block.tool_use_id ?? "",
          content: block.content,
          isError: block.is_error === true,
        });
      }
    }
  }
}

export async function runAgentTask(
  prompt: string,
  taskId: string,
  emit: AgentEventEmitter,
  abortController?: AbortController,
): Promise<void> {
  emit({ event: "task_started", taskId });
  try {
    const supervisor = getSupervisor();
    await supervisor.request("create_session", { session_id: SESSION_ID });

    const mcp = ensureSessionAndMcp();
    const options: Options = {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { capybara: mcp },
      allowedTools: ALLOWED_TOOLS,
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      abortController,
    };

    for await (const message of query({ prompt, options })) {
      relay(taskId, message, emit);
    }
  } catch (error) {
    emit({
      event: "assistant_message",
      taskId,
      text: `error: ${(error as Error).message}`,
    });
  }
  emit({ event: "task_finished", taskId });
}
