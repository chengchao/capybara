#!/usr/bin/env bun
// Fetches the runtimes pinned in src-tauri/runtime-manifest.json into
// src-tauri/{binaries,vendor}. Idempotent: re-runs are no-ops once the
// expected files exist. `sha256` in the manifest is the source of truth
// for what we trust; mismatch aborts the run.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PlatformEntry = { url: string; sha256: string };
type RuntimeEntry = {
  version: string;
  platforms: Record<string, PlatformEntry>;
};
type Manifest = Record<string, RuntimeEntry>;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_TAURI = join(SCRIPT_DIR, "..");
const MANIFEST_PATH = join(SRC_TAURI, "runtime-manifest.json");

async function main() {
  const target = await hostTriple();
  const manifest = (await Bun.file(MANIFEST_PATH).json()) as Manifest;
  const tmp = await mkdtemp(join(tmpdir(), "capybara-runtimes-"));
  try {
    for (const [name, runtime] of Object.entries(manifest)) {
      await installRuntime(name, runtime, target, tmp);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function installRuntime(
  name: string,
  runtime: RuntimeEntry,
  target: string,
  tmp: string,
) {
  if (isInstalled(name, target)) {
    log(`${name}: already installed; skipping`);
    return;
  }

  const platform = runtime.platforms[target];
  if (!platform) {
    die(
      `${name}: unsupported target '${target}' (supported: ${Object.keys(runtime.platforms).join(", ") || "none"})`,
    );
  }

  log(`${name}: downloading ${platform.url}`);
  const archive = join(tmp, `${name}-${basename(platform.url)}`);
  await download(platform.url, archive);

  const actualSha = await sha256File(archive);
  if (actualSha !== platform.sha256) {
    die(
      `${name}: sha256 mismatch for ${platform.url}\n  expected: ${platform.sha256}\n  actual:   ${actualSha}`,
    );
  }

  log(`${name}: extracting`);
  await extract(name, archive, target, tmp);
  log(`${name}: ok`);
}

function isInstalled(name: string, target: string): boolean {
  switch (name) {
    case "bun":
      return existsSync(join(SRC_TAURI, "binaries", `bun-${target}`));
    case "lima":
      return existsSync(join(SRC_TAURI, "vendor", "lima", "bin", "limactl"));
    default:
      die(`unknown runtime '${name}'`);
  }
}

async function extract(
  name: string,
  archive: string,
  target: string,
  tmp: string,
) {
  switch (name) {
    case "bun": {
      const stage = join(tmp, `stage-${name}`);
      await mkdir(stage, { recursive: true });
      await run(["unzip", "-q", archive, "-d", stage]);
      // Archive layout: bun-darwin-{x64|aarch64}/bun
      const arch = target.startsWith("aarch64") ? "aarch64" : "x64";
      const src = join(stage, `bun-darwin-${arch}`, "bun");
      const dest = join(SRC_TAURI, "binaries", `bun-${target}`);
      await mkdir(dirname(dest), { recursive: true });
      await run(["install", "-m", "0755", src, dest]);
      return;
    }
    case "lima": {
      const dest = join(SRC_TAURI, "vendor", "lima");
      await mkdir(dest, { recursive: true });
      await run(["tar", "-xzf", archive, "-C", dest]);
      return;
    }
  }
  die(`unknown runtime '${name}'`);
}

async function hostTriple(): Promise<string> {
  const out = await runCapture(["rustc", "--print", "host-tuple"]);
  const triple = out.trim();
  if (!triple) die("rustc --print host-tuple returned empty output");
  return triple;
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

async function download(url: string, dest: string) {
  await run([
    "curl",
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--proto",
    "=https",
    "--tlsv1.2",
    "--output",
    dest,
    url,
  ]);
}

async function run(argv: string[]) {
  const proc = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) die(`command failed (exit ${code}): ${argv.join(" ")}`);
}

async function runCapture(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    die(`command failed (exit ${code}): ${argv.join(" ")}\n${stderr.trim()}`);
  }
  return stdout;
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function log(message: string) {
  console.log(`fetch-runtimes: ${message}`);
}

function die(message: string): never {
  console.error(`fetch-runtimes: ${message}`);
  process.exit(1);
}

await main();
