import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { SupervisorClient } from "./supervisor";
import { buildTools, SESSION_ID } from "./tools";

type RequestMessage = {
  id?: string;
  method?: string;
  params?: unknown;
};

const supervisor = new SupervisorClient();

const mcpServer = createSdkMcpServer({
  name: "capybara",
  tools: buildTools(supervisor),
});

// MCP tools register with the SDK under `mcp__<server>__<tool>`. Strip the
// prefix when surfacing tool names to the host so the UI sees plain "Bash"
// / "Read" / "Glob".
const TOOL_PREFIX = "mcp__capybara__";
const ALLOWED_TOOLS = ["Bash", "Read", "Glob"].map((name) => TOOL_PREFIX + name);

const MODEL = process.env.CAPYBARA_AGENT_MODEL ?? "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Capybara, an office-work agent. Your tools (Bash, Read, Glob) execute inside a Lima VM sandbox; the working directory is /workspace, and connected host directories appear at /mnt/<name>. You cannot run commands on the host directly — everything routes through the sandbox.`;

function send(value: unknown): Promise<number> {
  return Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`);
}

function fail(id: string | undefined, message: string) {
  send({ id, ok: false, error: message });
}

send({ event: "agent_ready" });

async function handleLine(line: string) {
  let request: RequestMessage;
  try {
    request = JSON.parse(line) as RequestMessage;
  } catch {
    fail(undefined, "request was not valid JSON");
    return;
  }

  if (request.method === "shutdown") {
    await send({ id: request.id, ok: true, result: { ok: true } });
    await Promise.race([
      supervisor.shutdown(),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    process.exit(0);
  }

  if (request.method !== "start_task") {
    fail(request.id, `unknown method: ${request.method ?? "(missing)"}`);
    return;
  }

  const params = request.params as { prompt?: unknown };
  if (typeof params?.prompt !== "string" || params.prompt.trim() === "") {
    fail(request.id, "prompt is required");
    return;
  }
  const prompt = params.prompt;

  const taskId = crypto.randomUUID();
  send({ id: request.id, ok: true, result: { taskId } });
  send({ event: "task_started", taskId });

  try {
    await supervisor.request("create_session", { session_id: SESSION_ID });

    const iterator = query({
      prompt,
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { capybara: mcpServer },
        allowedTools: ALLOWED_TOOLS,
      },
    });

    for await (const message of iterator) {
      relayEvent(taskId, message);
    }
  } catch (error) {
    send({
      event: "assistant_message",
      taskId,
      text: `error: ${(error as Error).message}`,
    });
  }

  send({ event: "task_finished", taskId });
}

function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function relayEvent(taskId: string, message: unknown) {
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
        send({ event: "assistant_message", taskId, text: block.text });
      } else if (block.type === "tool_use") {
        send({
          event: "tool_use",
          taskId,
          tool: stripToolPrefix(block.name ?? ""),
          input: block.input,
          toolUseId: block.id,
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
        send({
          event: "tool_result",
          taskId,
          toolUseId: block.tool_use_id,
          content: block.content,
          isError: block.is_error === true,
        });
      }
    }
  }
}

const stdinLines = console as unknown as AsyncIterable<string>;
for await (const line of stdinLines) {
  await handleLine(line);
}

export {};
