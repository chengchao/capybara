// The models the picker offers. `id` is the exact model string passed to the
// SDK; keep the default (electron/settings.ts DEFAULT_MODEL) present in this list
// so a fresh install's effective model has a matching label. An effective model
// not in this list (e.g. a CAPYBARA_AGENT_MODEL env override) is still shown by
// the picker as a fallback row — see Settings.tsx.
export type ModelOption = { id: string; label: string; hint: string };

export const MODELS: ModelOption[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "Balanced — the default" },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Most capable, slower" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest, lightest" },
];

// A short display label for any model id (falls back to the raw id).
export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
