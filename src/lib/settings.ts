import type { SettingsState } from "./host";

export type { SettingsState };

export function getSettings(): Promise<SettingsState> {
  return window.capybara.getSettings();
}

export function setAnthropicApiKey(key: string): Promise<SettingsState> {
  return window.capybara.setAnthropicApiKey(key);
}

export function setModel(model: string): Promise<SettingsState> {
  return window.capybara.setModel(model);
}
