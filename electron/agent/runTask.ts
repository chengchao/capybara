import path from "node:path";

import { createSdkMcpServer, query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { app } from "electron";

import { getLlmProxy } from "../llmProxy";
import { getAnthropicApiKey, hasStoredApiKey } from "../settings";
import { getSupervisor } from "../vm";
import { ALLOWED_TOOLS, BUILTIN_TOOLS, DISALLOWED_TOOLS, TOOL_PREFIX } from "./allowedTools";
import { evaluateFileTool } from "./grants";
import { buildTools } from "./tools";

const MODEL = process.env.CAPYBARA_AGENT_MODEL ?? "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Capybara, an office-work agent. Read, Glob, and Write operate on the host filesystem using absolute paths, but only within directories the user has connected; if a path is not connected the tool is denied — call request_capybara_directory({ path }) to ask the user, then retry. Bash runs inside a Lima VM sandbox, a separate filesystem where the working directory is /workspace and connected host directories appear at /mnt/<name>. Files you Read/Write on the host are not visible to Bash unless they fall under a connected directory, and vice versa.`;

export type AgentEvent =
  | { event: "task_started"; taskId: string }
  | { event: "session_started"; taskId: string; sessionId: string }
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
  | { event: "task_finished"; taskId: string; sessionId?: string };

type AgentEventEmitter = (event: AgentEvent) => void;

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

// Map the SDK's 36-char UUID session id to a supervisor-valid VM session id
// (`^[a-z][a-z0-9_-]{0,22}$`): an `s` prefix to guarantee a letter-first id,
// plus 22 hex chars of the UUID. Deterministic, so a resumed conversation
// resolves to the same VM workspace.
function vmSessionId(sdkSessionId: string): string {
  return `s${sdkSessionId.replace(/-/g, "").slice(0, 22)}`;
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
  resumeSessionId?: string,
): Promise<void> {
  emit({ event: "task_started", taskId });

  const apiKey = getAnthropicApiKey() ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    emit({
      event: "assistant_message",
      taskId,
      text: hasStoredApiKey()
        ? "Your saved Anthropic API key couldn't be unlocked from the system keychain. Open Settings (⚙) and re-enter it."
        : "No Anthropic API key configured. Open Settings (⚙) and paste your ANTHROPIC_API_KEY to run the agent.",
    });
    emit({ event: "task_finished", taskId });
    return;
  }

  const supervisor = getSupervisor();
  // The VM sandbox session is keyed off the SDK session id: a new conversation
  // gets a fresh id (and so a fresh /workspace), and resuming reuses it (same
  // history, same workspace). For a resumed turn the id is known up front; for
  // a new one it arrives in the `init` message, which the SDK always emits
  // before the first tool call. The VM session is created lazily on first tool
  // use (idempotent). We can't hand the supervisor the SDK id raw — it's a
  // 36-char UUID, but the supervisor requires `^[a-z][a-z0-9_-]{0,22}$` — so we
  // derive a stable, valid id from it (deterministic, so resume maps to the
  // same workspace). The SDK id is still what we emit/resume on.
  let sessionId: string | null = resumeSessionId ?? null;
  let vmSession: Promise<unknown> | null = null;
  const resolveSession = async (): Promise<string> => {
    const id = sessionId;
    if (!id) throw new Error("agent tool used before the SDK session was initialized");
    const vmId = vmSessionId(id);
    if (!vmSession) vmSession = supervisor.request("create_session", { session_id: vmId });
    await vmSession;
    return vmId;
  };

  try {
    const mcp = createSdkMcpServer({
      name: "capybara",
      tools: buildTools(supervisor, resolveSession, () => {
        if (!sessionId)
          throw new Error("folder grant requested before the SDK session was initialized");
        return sessionId;
      }),
    });
    ensureBundledBunOnPath();
    const claudeBinary = resolveClaudeBinary();
    // The real key never enters the subprocess env: it gets the loopback
    // proxy's disposable token + base URL, and the proxy (in main) swaps the
    // token for the real key on the way to Anthropic. `apiKey` above is only
    // used for the pre-flight no-key/unreadable guard. The sibling auth/header
    // vars below are unset so a credential inherited from the launching shell
    // (e.g. a subscription user's CLAUDE_CODE_OAUTH_TOKEN) can't ride in via
    // `...process.env` — the claude CLI reads all of these.
    const proxy = getLlmProxy();
    const options: Options = {
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { capybara: mcp },
      // Availability: only these host built-ins exist for the model; every other
      // built-in (NotebookEdit, Grep, WebFetch, built-in Bash, ...) is removed,
      // so an ungated host-filesystem tool can't be reached. `allowedTools`
      // auto-approves them + the MCP tools; `disallowedTools` is belt-and-braces.
      tools: BUILTIN_TOOLS,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      // Gate the host file tools: deny any path the user hasn't connected, with
      // a reason that tells the model to call request_capybara_directory. The
      // hook runs in this (main) process and reads the SDK session id directly
      // from `input.session_id` — the same key the consent tool grants under.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const i = input as {
                  session_id: string;
                  tool_name: string;
                  tool_input: unknown;
                };
                const r = evaluateFileTool(i.session_id, i.tool_name, i.tool_input);
                if ("allow" in r) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: r.reason,
                  },
                };
              },
            ],
          },
        ],
      },
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      executable: app.isPackaged ? "bun" : "node",
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: proxy.token,
        ANTHROPIC_BASE_URL: proxy.baseUrl,
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_CUSTOM_HEADERS: undefined,
      },
      abortController,
    };

    for await (const message of query({ prompt, options })) {
      const init = message as { type?: string; subtype?: string; session_id?: string };
      if (
        init.type === "system" &&
        init.subtype === "init" &&
        typeof init.session_id === "string"
      ) {
        sessionId = init.session_id;
        emit({ event: "session_started", taskId, sessionId: init.session_id });
        continue;
      }
      relay(taskId, message, emit);
    }
  } catch (error) {
    emit({
      event: "assistant_message",
      taskId,
      text: `error: ${(error as Error).message}`,
    });
  }
  emit({ event: "task_finished", taskId, sessionId: sessionId ?? undefined });
}
