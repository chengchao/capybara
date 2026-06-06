import { useCallback, useState } from "react";

// Theme preference, persisted in localStorage (a trivial, non-sensitive UI
// setting) so it can be read synchronously at startup — before first paint — and
// avoid a light/dark flash. "system" follows the OS preference live.
export type Theme = "light" | "dark" | "system";

const KEY = "capybara.theme";

export function getStoredTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === "light" || t === "dark" || t === "system" ? t : "system";
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// shadcn themes via a `.dark` class on <html>; toggle it to match the resolved
// preference.
export function applyTheme(theme: Theme): void {
  const dark = theme === "system" ? prefersDark() : theme === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(KEY, next);
    applyTheme(next);
    setThemeState(next);
  }, []);
  return [theme, setTheme];
}
