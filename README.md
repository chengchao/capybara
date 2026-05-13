# Capybara

An office-work agent that runs commands inside a sandboxed Lima VM. Built with Electron + React + the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

## Setup

The app bundles three runtimes as internal resources: `limactl` (from [Lima](https://lima-vm.io)) for the VM, `bun` as the JS runtime for the Claude Agent SDK's `claude` binary, and the SDK's per-arch native binary itself. Lima and Bun are pinned by sha256 in `runtime-manifest.json`; the SDK ships via npm's per-platform optional deps.

```sh
bun install
bun run setup:runtimes      # fetches Lima + Bun (~100 MB)
export ANTHROPIC_API_KEY=…
bun run electron:dev
```

`setup:runtimes` reads `runtime-manifest.json`, matches the host's Rust target triple, downloads each archive, verifies sha256 (refuses install on mismatch), and extracts. Idempotent — re-runs skip when the binary already exists at the expected path. Currently supports `aarch64-apple-darwin` and `x86_64-apple-darwin`; add a triple to the manifest's `platforms` map to extend.

**Updating a pinned runtime:** bump `version` and `url` in the manifest, then refresh the `sha256` from the upstream archive (`shasum -a 256 <archive>` on macOS, `sha256sum <archive>` on Linux). Commit the manifest change so the new hash is reviewable.

## Building

```sh
bun run dist
```

Produces a signed `.dmg` (macOS) or `.exe` (Windows) under `release/`. macOS signing/notarization keys come from env vars (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`); absent keys yield an unsigned build that won't pass Gatekeeper.

The build chain: `setup:runtimes` → `check:electron` → `build:electron` → `build:renderer` → `electron-builder`. The `beforePack` hook stages the per-arch Bun binary into `build/bun` for `extraResources`. The `afterPack` hook strips the SDK's `vendor/claude-code-jetbrains-plugin/` jar tree (contains unsigned `.jnilib` files that would fail macOS notarization; see [claude-agent-sdk-typescript#91](https://github.com/anthropics/claude-agent-sdk-typescript/issues/91)).

## Architecture

On startup, the app boots a Lima VM named `agent` under `~/.capybara/lima` (anchored short to stay under macOS's 104-char `UNIX_PATH_MAX` for SSH sockets). First run downloads and provisions the Ubuntu cloud image (a few minutes); subsequent warm boots take ~10–15 s. Quitting the app stops the VM (best-effort, 10-second timeout).

The host talks to an in-VM supervisor over newline-delimited JSON on stdin/stdout. See [docs/supervisor-protocol.md](docs/supervisor-protocol.md) for the protocol contract. The agent loop runs in Electron's main process via the Claude Agent SDK; its Bash/Read/Glob tools are intercepted and routed through `run_as_session` so every command executes inside a bubblewrap sandbox at `/workspace`.
