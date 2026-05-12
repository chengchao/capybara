// Copy the host-arch Bun binary into `build/bun` so electron-builder can pick
// it up as an extraResource without per-arch path templating in the config.
//
// The Bun binary serves as the SDK's `executable` arg at runtime — end users
// don't have `node` on PATH, and Electron's process.execPath is the
// Electron binary itself, not a node interpreter. See pheuter/claude-agent-desktop
// for the same pattern.

const path = require("node:path");
const fs = require("node:fs/promises");
const fsConst = require("node:fs").constants;

const ARCH_TO_RUST_TRIPLE = {
  darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
  linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
};

exports.default = async function beforePack(context) {
  const arch = context.arch === 1 ? "ia32"
    : context.arch === 2 ? "x64"
    : context.arch === 3 ? "armv7l"
    : context.arch === 4 ? "arm64"
    : "unknown";
  const platform = process.platform;
  const triple = ARCH_TO_RUST_TRIPLE[platform]?.[arch];
  if (!triple) {
    throw new Error(`beforePack: no Bun mapping for ${platform}/${arch}`);
  }
  const src = path.join(__dirname, "..", "src-tauri", "binaries", `bun-${triple}`);
  const dst = path.join(__dirname, "bun");
  try {
    await fs.access(src, fsConst.X_OK);
  } catch {
    throw new Error(
      `beforePack: missing or not-executable ${src}. Run \`bun run setup:runtimes\` for this arch first.`,
    );
  }
  await fs.copyFile(src, dst);
  await fs.chmod(dst, 0o755);
  console.log(`beforePack: staged Bun binary for ${platform}/${arch} (${triple})`);
};
