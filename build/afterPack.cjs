// Strip the unsigned JetBrains plugin jar from the Claude Agent SDK platform
// packages before macOS notarization runs. The SDK ships
// vendor/claude-code-jetbrains-plugin/lib/jansi-2.4.1.jar with three
// unsigned .jnilib files inside; notarytool rejects them.
//
// Tracking: anthropics/claude-agent-sdk-typescript#91.

const path = require("node:path");
const fs = require("node:fs/promises");

exports.default = async function afterPack(context) {
  const productFilename = context.packager.appInfo.productFilename;
  const unpacked = process.platform === "darwin"
    ? path.join(
        context.appOutDir,
        `${productFilename}.app`,
        "Contents",
        "Resources",
        "app.asar.unpacked",
      )
    : path.join(context.appOutDir, "resources", "app.asar.unpacked");

  const anthropicDir = path.join(unpacked, "node_modules", "@anthropic-ai");
  let entries;
  try {
    entries = await fs.readdir(anthropicDir);
  } catch (e) {
    if ((e).code !== "ENOENT") throw e;
    console.warn(`afterPack: ${anthropicDir} not present; skipping JetBrains strip`);
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("claude-agent-sdk-")) continue;
    if (entry === "claude-agent-sdk") continue;
    const jbDir = path.join(
      anthropicDir,
      entry,
      "vendor",
      "claude-code-jetbrains-plugin",
    );
    try {
      await fs.rm(jbDir, { recursive: true, force: true });
      console.log(`afterPack: stripped ${jbDir}`);
    } catch (e) {
      console.error(`afterPack: failed to strip ${jbDir}: ${e.message}`);
    }
  }
};
