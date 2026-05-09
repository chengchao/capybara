# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Setup

The app bundles `limactl` (from [Lima](https://lima-vm.io)) as an internal resource. Fetch it once before your first dev/build:

```sh
bun install
bun run setup       # downloads Lima into src-tauri/vendor/lima/
bun run tauri dev
```

`bun run setup` is idempotent and pinned to a single Lima version (see `src-tauri/scripts/fetch-lima.sh`). It supports macOS only (arm64 / x86_64).

On startup, the app boots a Lima VM named `agent` under `~/.capybara/lima` (anchored short to stay under macOS's 104-char `UNIX_PATH_MAX` for SSH sockets — Tauri's `app_data_dir` is too long). First run downloads and provisions the cloud image (a few minutes); subsequent warm boots take ~10–15 s. Quitting the app stops the VM (best-effort, 10-second timeout). VM lifecycle progress and failures are printed to stderr — visible in the `tauri dev` terminal or `Console.app` for release builds.

The host talks to the VM supervisor over newline-delimited JSON on
stdin/stdout. See [docs/supervisor-protocol.md](docs/supervisor-protocol.md)
for the current protocol contract.
