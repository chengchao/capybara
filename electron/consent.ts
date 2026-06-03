import { app, BrowserWindow, dialog } from "electron";

// Native Allow/Deny dialog for a host folder-access request; returns true on
// Allow. CAPYBARA_AUTO_CONSENT=1 auto-approves — the dialog is a native OS modal
// that headless e2e (CDP) can't click, so the flag drives the allow path there.
// Dev-only: fenced behind `!app.isPackaged` so it can't disable consent in a
// shipped build.
export async function requestDirectoryConsent(p: string): Promise<boolean> {
  if (!app.isPackaged && process.env.CAPYBARA_AUTO_CONSENT === "1") return true;
  const opts = {
    type: "question" as const,
    message: `Capybara wants to access ${p}`,
    buttons: ["Deny", "Allow"],
    defaultId: 0,
    cancelId: 0,
  };
  // One window; `mainWindow` in main.ts is block-scoped and not exported.
  const win = BrowserWindow.getAllWindows()[0];
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  return response === 1;
}
