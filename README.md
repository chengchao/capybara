# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Setup

The app bundles two runtimes as internal resources: `limactl` (from [Lima](https://lima-vm.io)) for the VM, and `bun` as a Tauri sidecar for the agent. Both are pinned by sha256 in `src-tauri/runtime-manifest.json` and fetched by a single setup step:

```sh
bun install
bun run tauri dev   # before*Command hooks call setup:runtimes for you
```

Or run the fetcher explicitly:

```sh
bun run setup:runtimes
```

`setup:runtimes` reads `src-tauri/runtime-manifest.json`, matches the host's Rust target triple (`rustc --print host-tuple`), downloads the pinned archive, verifies sha256 (refuses install on mismatch), and extracts. It's idempotent — re-runs skip when the binary already exists at the expected path. Currently supports `aarch64-apple-darwin` and `x86_64-apple-darwin`; add a triple to the manifest's `platforms` map to extend.

**Bootstrap requirements:** Bun must be pre-installed on the dev machine (for `setup:runtimes` itself and the Vite/agent build). CI installs Bun in its first step. End users get a fully-bundled `.app` / `.dmg` from CI — they never run `setup:runtimes`.

**Updating a pinned runtime:** bump `version` and `url` in the manifest, then refresh the `sha256` from the upstream archive (`shasum -a 256 <archive>`). Commit the manifest change so the new hash is reviewable.

On startup, the app boots a Lima VM named `agent` under `~/.capybara/lima` (anchored short to stay under macOS's 104-char `UNIX_PATH_MAX` for SSH sockets — Tauri's `app_data_dir` is too long). First run downloads and provisions the cloud image (a few minutes); subsequent warm boots take ~10–15 s. Quitting the app stops the VM (best-effort, 10-second timeout). VM lifecycle progress and failures are printed to stderr — visible in the `tauri dev` terminal or `Console.app` for release builds.

The host talks to the VM supervisor over newline-delimited JSON on
stdin/stdout. See [docs/supervisor-protocol.md](docs/supervisor-protocol.md)
for the current protocol contract.
