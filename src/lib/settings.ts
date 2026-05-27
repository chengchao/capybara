import type { ApiKeyState } from "./host";

export type { ApiKeyState };

export function getSettings(): Promise<ApiKeyState> {
  return window.capybara.getSettings();
}

export function setAnthropicApiKey(key: string): Promise<ApiKeyState> {
  return window.capybara.setAnthropicApiKey(key);
}
