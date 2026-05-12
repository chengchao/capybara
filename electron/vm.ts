import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { app } from "electron";

const INSTANCE_NAME = "agent";
const SUPERVISOR_RESPONSE_TIMEOUT_MS = 30_000;
const SUPERVISOR_COMMAND_RESPONSE_GRACE_MS = 5_000;

const AGENT_YAML = `base: template:default
cpus: 2
memory: 2GiB
disk: 20GiB
ssh:
  loadDotSSHPubKeys: false
  forwardAgent: false
mounts:
  - location: "~"
    mountPoint: "/host-home"
    writable: true
`;

export type VmStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "failed"; reason: string };

export type StatusEmitter = (status: VmStatus) => void;

let currentStatus: VmStatus = { kind: "starting" };
let supervisor: SupervisorClient | null = null;
let statusEmitter: StatusEmitter = () => {};

export function setStatusEmitter(emit: StatusEmitter): void {
  statusEmitter = emit;
  emit(currentStatus);
}

export function getVmStatus(): VmStatus {
  return currentStatus;
}

function updateStatus(status: VmStatus): void {
  currentStatus = status;
  statusEmitter(status);
}

type LimaPaths = {
  limactl: string;
  limaHome: string;
  supervisorSource: string;
  hostHome: string;
};

let cachedPaths: LimaPaths | null = null;

function paths(): LimaPaths {
  if (cachedPaths) return cachedPaths;
  // Dev: vendor/ and resources/ live at project root. Prod:
  // process.resourcesPath after electron-builder packaging.
  const resourceDir = app.isPackaged
    ? process.resourcesPath
    : app.getAppPath();
  // LIMA_HOME must stay short on macOS: Lima writes `<LIMA_HOME>/<instance>/ssh.sock.<PID>`,
  // bounded by UNIX_PATH_MAX (104). `~/Library/Application Support/<bundle-id>/lima/`
  // already pushes that to ~107 with a 16-digit PID, so anchor at `~/.capybara/lima`.
  cachedPaths = {
    limactl: path.join(resourceDir, "vendor", "lima", "bin", "limactl"),
    limaHome: path.join(homedir(), ".capybara", "lima"),
    supervisorSource: path.join(
      resourceDir,
      "resources",
      "supervisor",
      "capybara_supervisor.py",
    ),
    hostHome: homedir(),
  };
  return cachedPaths;
}

function commandResponseTimeoutMs(timeoutMs: number): number {
  return timeoutMs + SUPERVISOR_COMMAND_RESPONSE_GRACE_MS;
}

async function ensureExecutable(filePath: string): Promise<void> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) {
      throw new Error(`limactl path is not a file: ${filePath}`);
    }
    if ((st.mode & 0o111) === 0) {
      throw new Error(`limactl is not executable: ${filePath}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`limactl missing at ${filePath}`);
    }
    throw e;
  }
}

async function ensureRegularFile(filePath: string): Promise<void> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) {
      throw new Error(`expected a regular file: ${filePath}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`file missing: ${filePath}`);
    }
    throw e;
  }
}

async function runLimactl(args: string[]): Promise<string> {
  const p = paths();
  return new Promise((resolve, reject) => {
    const child = spawn(p.limactl, args, {
      env: { ...process.env, LIMA_HOME: p.limaHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `limactl exited ${code ?? "?"}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
      }
    });
  });
}

type LimaInstance = { name: string; status: string };

function parseListOutput(s: string): LimaInstance[] {
  const out: LimaInstance[] = [];
  for (const [idx, raw] of s.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as LimaInstance;
      if (typeof parsed.name !== "string" || typeof parsed.status !== "string") {
        throw new Error(`missing required field`);
      }
      out.push(parsed);
    } catch (e) {
      throw new Error(
        `could not parse limactl list line ${idx + 1}: ${(e as Error).message} (snippet: ${line.slice(0, 120)})`,
      );
    }
  }
  return out;
}

async function smokeTestHostMount(): Promise<void> {
  // A working virtiofs mount makes the host home visible at /host-home; without it
  // (stale instance config) the path is missing and `test -d` exits non-zero.
  // Distinguish a non-zero exit (mount truly missing) from other failures so
  // unrelated breakage isn't misreported as a mount problem.
  process.stderr.write("vm: verifying host home mount...\n");
  try {
    await runLimactl(["shell", INSTANCE_NAME, "--", "test", "-d", "/host-home"]);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("limactl exited")) {
      throw new Error(
        `host home ${paths().hostHome} is not visible inside the VM. The existing instance was created without the mount; delete it and restart:\n    rm -rf ~/.capybara/lima`,
      );
    }
    throw e;
  }
}

async function installSupervisor(): Promise<void> {
  const p = paths();
  await ensureRegularFile(p.supervisorSource);
  process.stderr.write("vm: installing supervisor...\n");
  await runLimactl([
    "shell",
    INSTANCE_NAME,
    "--",
    "sudo",
    "mkdir",
    "-p",
    "/opt/capybara",
  ]);
  await runLimactl([
    "copy",
    p.supervisorSource,
    `${INSTANCE_NAME}:/tmp/capybara_supervisor.py`,
  ]);
  await runLimactl([
    "shell",
    INSTANCE_NAME,
    "--",
    "sudo",
    "install",
    "-m",
    "0755",
    "/tmp/capybara_supervisor.py",
    "/opt/capybara/supervisor.py",
  ]);
}

async function ensureBwrap(): Promise<void> {
  process.stderr.write("vm: ensuring bubblewrap...\n");
  await runLimactl([
    "shell",
    INSTANCE_NAME,
    "--",
    "sh",
    "-lc",
    "command -v bwrap >/dev/null || (sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap)",
  ]);
  await runLimactl(["shell", INSTANCE_NAME, "--", "bwrap", "--version"]);
}

type RpcResponse = {
  id?: string;
  result?: unknown;
  error?: { message: string };
};

export class SupervisorClient {
  private child: ChildProcess | null = null;
  private nextId = 0;
  private chain: Promise<void> = Promise.resolve();
  private linesIter: AsyncGenerator<string> | null = null;

  static async start(): Promise<SupervisorClient> {
    const client = new SupervisorClient();
    client.spawnChild();
    return client;
  }

  async request(
    method: string,
    params: unknown = {},
    timeoutMs: number = SUPERVISOR_RESPONSE_TIMEOUT_MS,
  ): Promise<unknown> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (!this.child) this.spawnChild();
      return await this.send(method, params, timeoutMs);
    } finally {
      release();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("shutdown");
    } catch {
      // best-effort
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
      this.linesIter = null;
    }
  }

  private spawnChild(): void {
    const p = paths();
    this.child = spawn(
      p.limactl,
      [
        "shell",
        INSTANCE_NAME,
        "--",
        "sudo",
        "python3",
        "/opt/capybara/supervisor.py",
      ],
      {
        env: { ...process.env, LIMA_HOME: p.limaHome },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    this.child.on("exit", () => {
      this.child = null;
      this.linesIter = null;
    });
    if (!this.child.stdout) {
      throw new Error("supervisor stdout unavailable");
    }
    this.linesIter = lineIterator(this.child.stdout);
  }

  private async send(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!this.child || !this.child.stdin || !this.linesIter) {
      throw new Error("supervisor handle is not initialized");
    }
    try {
      this.nextId += 1;
      const id = String(this.nextId);
      const payload = JSON.stringify({ id, method, params }) + "\n";
      this.child.stdin.write(payload);

      const next = await withTimeout(this.linesIter.next(), timeoutMs);
      if (next.done) throw new Error("supervisor exited without responding");
      const response = JSON.parse(next.value) as RpcResponse;
      if (response.id !== id) {
        throw new Error(
          `supervisor response id mismatch: expected ${id}, got ${response.id ?? "null"}`,
        );
      }
      if (response.error) throw new Error(response.error.message);
      if (response.result === undefined) {
        throw new Error("response missing result");
      }
      return response.result;
    } catch (error) {
      // Errors may leave stdout offset (late response, partial line, EOF).
      // Drop the handle so the next request respawns instead of reading the
      // stale response. Clean supervisor-side errors pay the same respawn cost
      // (~200ms) — trivial vs. distinguishing variants.
      if (this.child) {
        this.child.kill();
        this.child = null;
      }
      this.linesIter = null;
      throw error;
    }
  }
}

async function* lineIterator(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += (chunk as Buffer).toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      yield buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("supervisor response timed out")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function smokeTestSupervisor(client: SupervisorClient): Promise<void> {
  process.stderr.write("vm: testing supervisor...\n");
  await client.request("ping");
  await client.request("create_session", { session_id: "smoke_session" });
  try {
    const result = (await client.request(
      "run_as_session",
      {
        session_id: "smoke_session",
        cwd: "/workspace",
        command: "id -un && pwd",
        timeout_ms: 5000,
      },
      commandResponseTimeoutMs(5000),
    )) as { exitCode?: number; stderr?: string };
    if (result.exitCode !== 0) {
      throw new Error(
        `smoke command failed with ${result.exitCode}: ${result.stderr ?? ""}`,
      );
    }
  } finally {
    await client
      .request("delete_session", { session_id: "smoke_session" })
      .catch(() => {});
  }
}

export async function ensureVm(): Promise<void> {
  updateStatus({ kind: "starting" });

  try {
    const p = paths();
    await mkdir(p.limaHome, { recursive: true });
    await ensureExecutable(p.limactl);

    const listJson = await runLimactl(["list", "--format=json"]);
    const instances = parseListOutput(listJson);
    const existing = instances.find((i) => i.name === INSTANCE_NAME);

    if (!existing) {
      process.stderr.write(
        "vm: downloading image (first run, this may take a minute)...\n",
      );
      const yamlPath = path.join(p.limaHome, `${INSTANCE_NAME}.yaml`);
      await writeFile(yamlPath, AGENT_YAML, "utf8");
      // The raw host-home mount is a supervisor source path, not a sandbox path.
      // Session commands run through bubblewrap and only see approved subdirs
      // rebound into /mnt/<name>.
      await runLimactl([
        "create",
        "--name",
        INSTANCE_NAME,
        "--tty=false",
        yamlPath,
      ]);
      process.stderr.write("vm: starting...\n");
      await runLimactl(["start", INSTANCE_NAME, "--tty=false"]);
    } else if (existing.status !== "Running") {
      process.stderr.write("vm: starting...\n");
      await runLimactl(["start", INSTANCE_NAME, "--tty=false"]);
    }

    await smokeTestHostMount();
    await ensureBwrap();
    await installSupervisor();

    const client = await SupervisorClient.start();
    // Reap orphan bwrap children from a previous app session's supervisor
    // crash. Safe here because the agent loop hasn't issued any tool calls
    // yet — no in-flight `run_as_session` to trash.
    await client.request("cleanup_orphans");
    await smokeTestSupervisor(client);
    supervisor = client;

    updateStatus({ kind: "running" });
    process.stderr.write("vm: ready\n");
  } catch (e) {
    const reason = (e as Error).message;
    updateStatus({ kind: "failed", reason });
    throw e;
  }
}

export function getSupervisor(): SupervisorClient {
  if (!supervisor) {
    throw new Error(
      "supervisor not initialized; VM is still starting or failed to boot",
    );
  }
  return supervisor;
}

export async function stopSupervisor(): Promise<void> {
  const client = supervisor;
  supervisor = null;
  if (!client) return;
  try {
    await client.shutdown();
  } catch (e) {
    process.stderr.write(
      `vm: supervisor shutdown failed: ${(e as Error).message}\n`,
    );
  }
}

export async function stopVm(): Promise<void> {
  process.stderr.write("vm: stopping...\n");
  try {
    await runLimactl(["stop", INSTANCE_NAME, "--tty=false"]);
  } catch (e) {
    process.stderr.write(`vm: stop failed: ${(e as Error).message}\n`);
  }
}

// Re-export request_supervisor analog so IPC handlers in Phase 5 can call
// methods symmetrically with the agent loop (Phase 3+).
export async function requestSupervisor<T = unknown>(
  method: string,
  params: unknown = {},
  timeoutMs?: number,
): Promise<T> {
  const client = getSupervisor();
  return (await client.request(method, params, timeoutMs)) as T;
}
