import { SupervisorClient } from "./supervisor";

type RequestMessage = {
  id?: string;
  method?: string;
  params?: unknown;
};

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

// Smoke-test session for the pre-PR-E wiring. The real LLM-driven loop in
// PR-E will manage sessions on its own; for now we just bash the prompt.
const PROBE_SESSION_ID = "agent_probe";

const supervisor = new SupervisorClient();

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
    await supervisor.request("create_session", { session_id: PROBE_SESSION_ID });
    const result = (await supervisor.request("run_as_session", {
      session_id: PROBE_SESSION_ID,
      command: prompt,
      cwd: "/workspace",
      timeout_ms: 30000,
    })) as RunResult;
    const text =
      result.exitCode === 0
        ? result.stdout || "(no output)"
        : `[exit ${result.exitCode}] ${result.stderr || result.stdout}`;
    send({ event: "assistant_message", taskId, text });
  } catch (error) {
    send({
      event: "assistant_message",
      taskId,
      text: `error: ${(error as Error).message}`,
    });
  }
  send({ event: "task_finished", taskId });
}

const stdinLines = console as unknown as AsyncIterable<string>;
for await (const line of stdinLines) {
  await handleLine(line);
}

export {};
