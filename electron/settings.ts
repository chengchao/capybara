import fs from "node:fs";
import path from "node:path";

import { app, safeStorage } from "electron";

// The key is encrypted at rest with the OS credential store (Keychain on
// macOS, DPAPI on Windows, libsecret/kwallet on Linux) via safeStorage and
// kept as base64 ciphertext. The field name carries the `Enc` suffix so the
// on-disk shape is unambiguous. `model` is the user-chosen agent model (plain
// text, not a secret).
type Settings = { anthropicApiKeyEnc?: string; model?: string };

// The model used when the user hasn't picked one and no env override is set.
export const DEFAULT_MODEL = "claude-sonnet-4-6";

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
  const p = settingsPath();
  fs.writeFileSync(p, JSON.stringify(settings, null, 2), { mode: 0o600 });
  // writeFileSync's `mode` only applies when the file is created; on an
  // overwrite the prior (umask, often 0o644) mode sticks, so chmod every time
  // to keep the ciphertext owner-only as defence-in-depth on top of safeStorage.
  fs.chmodSync(p, 0o600);
}

/** Whether a key has been saved, regardless of whether it can be decrypted now. */
export function hasStoredApiKey(): boolean {
  return Boolean(read().anthropicApiKeyEnc);
}

export function getAnthropicApiKey(): string | undefined {
  const enc = read().anthropicApiKeyEnc;
  if (!enc || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64")) || undefined;
  } catch {
    // Decrypt can fail when the keyring is locked/unavailable or the ciphertext
    // was copied from another machine. Return undefined; callers use
    // hasStoredApiKey() to tell "stored but unreadable" apart from "no key".
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

// The agent model to run: the user's saved choice, else a dev env override, else
// the default. Used both to configure a task and to report the effective model.
export function effectiveModel(): string {
  return read().model || process.env.CAPYBARA_AGENT_MODEL || DEFAULT_MODEL;
}

export function setModel(model: string): void {
  const settings = read();
  if (model) settings.model = model;
  else delete settings.model;
  write(settings);
}
