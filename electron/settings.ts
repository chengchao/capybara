import fs from "node:fs";
import path from "node:path";

import { app, safeStorage } from "electron";

// The key is encrypted at rest with the OS credential store (Keychain on
// macOS, DPAPI on Windows, libsecret/kwallet on Linux) via safeStorage and
// kept as base64 ciphertext. The field name carries the `Enc` suffix so the
// on-disk shape is unambiguous.
type Settings = { anthropicApiKeyEnc?: string };

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function read(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

function write(settings: Settings): void {
  // 0o600 is defence-in-depth on top of safeStorage's encryption.
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function getAnthropicApiKey(): string | undefined {
  const enc = read().anthropicApiKeyEnc;
  if (!enc || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64")) || undefined;
  } catch {
    // Ciphertext that won't decrypt (e.g. copied from another machine/user)
    // is treated as no key configured rather than a hard failure.
    return undefined;
  }
}

export function setAnthropicApiKey(key: string): void {
  const settings = read();
  if (key) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure storage is unavailable on this system; the API key was not saved.");
    }
    settings.anthropicApiKeyEnc = safeStorage.encryptString(key).toString("base64");
  } else {
    delete settings.anthropicApiKeyEnc;
  }
  write(settings);
}
