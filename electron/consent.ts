import { app, BrowserWindow, dialog } from "electron";

// Folder-access consent. The preferred path is INLINE: emit a `consent_request`
// to the renderer (over the agent-event channel) and await the user's choice via
// `respondConsent`, so the prompt renders as an Allow/Deny card in the
// conversation. With no renderer (headless e2e, or pre-window), fall back to a
// native OS dialog. CAPYBARA_AUTO_CONSENT=1 auto-approves (dev-only) for the
// CDP tests that can't click either surface.

type Pending = { resolve: (allow: boolean) => void };
const pending = new Map<string, Pending>();
let counter = 0;

export function respondConsent(requestId: string, allow: boolean): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  p.resolve(allow);
}

export function requestDirectoryConsent(path: string): Promise<boolean> {
  if (!app.isPackaged && process.env.CAPYBARA_AUTO_CONSENT === "1") return Promise.resolve(true);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isDestroyed()) return nativeDialog(path);

  const requestId = `consent-${++counter}`;
  return new Promise<boolean>((resolve) => {
    pending.set(requestId, { resolve });
    // If the window goes away before the user answers, treat it as a deny so the
    // agent's tool call never hangs.
    win.webContents.once("destroyed", () => respondConsent(requestId, false));
    win.webContents.send("agent-event", { event: "consent_request", requestId, path });
  });
}

async function nativeDialog(path: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: `Capybara wants to access ${path}`,
    buttons: ["Deny", "Allow"],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
}
