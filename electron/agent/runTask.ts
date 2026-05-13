import {
  createSdkMcpServer,
  query,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { app } from "electron";
import { getSupervisor } from "../vm";
import { buildTools, SESSION_ID } from "./tools";

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

// SDK ≥0.2.113 spawns a per-arch native `claude` binary from
// `@anthropic-ai/claude-agent-sdk-<triple>/claude`. In dev the SDK's own
// auto-resolve finds it in node_modules; in a packaged Electron build,
// require.resolve lands inside `app.asar` (where the kernel can't exec
// from), so we override with the asar.unpacked path that `asarUnpack`
// has materialised on disk.
function resolveClaudeBinary(): string | undefined {
  if (!app.isPackaged) return undefined;
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    "claude",
  );
}

// The SDK's `executable` option (`bun` / `node` / `deno`) still selects the
// JS runtime it uses to coordinate the native binary. End users don't have
// any of those on PATH — Electron's process.execPath is the Electron binary
// itself, not a JS runtime. We bundle a per-arch Bun binary as an
// extraResource and prepend its dir to PATH so `executable: "bun"` resolves.
let pathPrepended = false;
function ensureBundledBunOnPath(): void {
  if (pathPrepended || !app.isPackaged) return;
  const bundledDir = process.resourcesPath;
  process.env.PATH = `${bundledDir}${path.delimiter}${process.env.PATH ?? ""}`;
  pathPrepended = true;
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
    ensureBundledBunOnPath();
    const claudeBinary = resolveClaudeBinary();
    const options: Options = {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { capybara: mcp },
      allowedTools: ALLOWED_TOOLS,
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      executable: app.isPackaged ? "bun" : "node",
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
