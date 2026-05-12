// @bun
// src/supervisor.ts
function spawnSupervisorProcess() {
  const limactl = requireEnv("CAPYBARA_LIMACTL");
  const limaHome = requireEnv("LIMA_HOME");
  const instance = requireEnv("CAPYBARA_LIMA_INSTANCE");
  return Bun.spawn([
    limactl,
    "shell",
    instance,
    "--",
    "sudo",
    "python3",
    "/opt/capybara/supervisor.py"
  ], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, LIMA_HOME: limaHome }
  });
}

class SupervisorClient {
  proc = null;
  lines = null;
  nextId = 0;
  chain = Promise.resolve();
  async request(method, params = {}) {
    const previous = this.chain;
    let release;
    this.chain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      this.ensureStarted();
      return await this.send(method, params);
    } finally {
      release();
    }
  }
  async shutdown() {
    if (!this.proc)
      return;
    try {
      await this.request("shutdown");
    } catch {}
    try {
      await this.proc.exited;
    } catch {}
    this.proc = null;
    this.lines = null;
  }
  ensureStarted() {
    if (this.proc)
      return;
    this.proc = spawnSupervisorProcess();
    this.lines = lineIterator(this.proc.stdout);
  }
  async send(method, params) {
    const id = String(++this.nextId);
    const payload = JSON.stringify({ id, method, params }) + `
`;
    this.proc.stdin.write(payload);
    await this.proc.stdin.flush();
    const next = await this.lines.next();
    if (next.done) {
      throw new Error("supervisor exited without responding");
    }
    const response = JSON.parse(next.value);
    if (response.id !== id) {
      throw new Error(`supervisor response id mismatch: expected ${id}, got ${response.id ?? "null"}`);
    }
    if (response.error) {
      throw new Error(response.error.message);
    }
    return response.result;
  }
}
function requireEnv(key) {
  const value = process.env[key];
  if (!value)
    throw new Error(`missing required env var: ${key}`);
  return value;
}
async function* lineIterator(stream) {
  const decoder = new TextDecoder;
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf(`
`);
    while (idx >= 0) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf(`
`);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0)
    yield buffer;
}

// src/index.ts
var PROBE_SESSION_ID = "agent_probe";
var supervisor = new SupervisorClient;
function send(value) {
  return Bun.write(Bun.stdout, `${JSON.stringify(value)}
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
    await send({ id: request.id, ok: true, result: { ok: true } });
    await Promise.race([
      supervisor.shutdown(),
      new Promise((resolve) => setTimeout(resolve, 500))
    ]);
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
  const prompt = params.prompt;
  const taskId = crypto.randomUUID();
  send({ id: request.id, ok: true, result: { taskId } });
  send({ event: "task_started", taskId });
  try {
    await supervisor.request("create_session", { session_id: PROBE_SESSION_ID });
    const result = await supervisor.request("run_as_session", {
      session_id: PROBE_SESSION_ID,
      command: prompt,
      cwd: "/workspace",
      timeout_ms: 30000
    });
    const text = result.exitCode === 0 ? result.stdout || "(no output)" : `[exit ${result.exitCode}] ${result.stderr || result.stdout}`;
    send({ event: "assistant_message", taskId, text });
  } catch (error) {
    send({
      event: "assistant_message",
      taskId,
      text: `error: ${error.message}`
    });
  }
  send({ event: "task_finished", taskId });
}
var stdinLines = console;
for await (const line of stdinLines) {
  await handleLine(line);
}
