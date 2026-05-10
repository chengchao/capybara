// @bun
// src/index.ts
function send(value) {
  Bun.write(Bun.stdout, `${JSON.stringify(value)}
`);
}
function fail(id, message) {
  send({ id, ok: false, error: message });
}
send({ event: "agent_ready" });
async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(undefined, "request was not valid JSON");
    return;
  }
  if (request.method === "shutdown") {
    send({ id: request.id, ok: true, result: { ok: true } });
    process.exit(0);
  }
  if (request.method !== "start_task") {
    fail(request.id, `unknown method: ${request.method ?? "(missing)"}`);
    return;
  }
  const params = request.params;
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
    text: "Agent sidecar is running. Tool wiring comes next."
  });
  send({ event: "task_finished", taskId });
}
var stdinLines = console;
for await (const line of stdinLines) {
  await handleLine(line);
}
