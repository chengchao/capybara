// JSON-RPC client for the in-VM supervisor (Pattern 2: the agent owns
// `run_as_session` directly via its own `limactl shell` channel).
//
// Strict serial: each request awaits the previous one to complete. The
// supervisor is itself strictly serial, so pipelining wouldn't add throughput.

type RpcResponse = {
  id?: string;
  result?: unknown;
  error?: { message: string };
};

type Subprocess = ReturnType<typeof spawnSupervisorProcess>;

function spawnSupervisorProcess() {
  const limactl = requireEnv("CAPYBARA_LIMACTL");
  const limaHome = requireEnv("LIMA_HOME");
  const instance = requireEnv("CAPYBARA_LIMA_INSTANCE");
  return Bun.spawn(
    [
      limactl,
      "shell",
      instance,
      "--",
      "sudo",
      "python3",
      "/opt/capybara/supervisor.py",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, LIMA_HOME: limaHome },
    },
  );
}

export class SupervisorClient {
  private proc: Subprocess | null = null;
  private lines: AsyncGenerator<string> | null = null;
  private nextId = 0;
  private chain: Promise<void> = Promise.resolve();

  async request(method: string, params: unknown = {}): Promise<unknown> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
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

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request("shutdown");
    } catch {
      // supervisor may already be gone; best-effort
    }
    try {
      await this.proc.exited;
    } catch {
      // ignored
    }
    this.proc = null;
    this.lines = null;
  }

  private ensureStarted() {
    if (this.proc) return;
    this.proc = spawnSupervisorProcess();
    this.lines = lineIterator(this.proc.stdout);
  }

  private async send(method: string, params: unknown): Promise<unknown> {
    try {
      const id = String(++this.nextId);
      const payload = JSON.stringify({ id, method, params }) + "\n";
      this.proc!.stdin.write(payload);
      await this.proc!.stdin.flush();

      const next = await this.lines!.next();
      if (next.done) {
        throw new Error("supervisor exited without responding");
      }
      const response = JSON.parse(next.value) as RpcResponse;
      if (response.id !== id) {
        throw new Error(
          `supervisor response id mismatch: expected ${id}, got ${response.id ?? "null"}`,
        );
      }
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.result;
    } catch (error) {
      // Errors may leave stdout offset (late response, partial line, EOF).
      // Drop the proc handle so the next request respawns instead of
      // reading the stale response. ensureStarted will spawn fresh.
      this.proc = null;
      this.lines = null;
      throw error;
    }
  }
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`missing required env var: ${key}`);
  return value;
}

async function* lineIterator(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}
