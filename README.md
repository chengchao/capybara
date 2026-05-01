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

In dev builds, the app runs a Lima smoke test on startup and exits non-zero if `limactl` is missing or unusable; in release builds the same failure is logged but does not block the window from opening.
