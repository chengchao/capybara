type RequestMessage = {
  id?: string;
  method?: string;
  params?: unknown;
};

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

  const taskId = crypto.randomUUID();
  send({ id: request.id, ok: true, result: { taskId } });
  send({ event: "task_started", taskId });
  send({
    event: "assistant_message",
    taskId,
    text: "Agent sidecar is running. Tool wiring comes next.",
  });
  send({ event: "task_finished", taskId });
}

const stdinLines = console as unknown as AsyncIterable<string>;
for await (const line of stdinLines) {
  await handleLine(line);
}

export {};
