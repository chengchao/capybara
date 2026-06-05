import { app, BrowserWindow, dialog } from "electron";

// Folder-access consent. The preferred path is INLINE: emit a `consent_request`
// to the renderer (over the agent-event channel) and await the user's choice via
// `respondConsent`, so the prompt renders as an Allow/Deny card in the
// conversation. With no renderer (headless e2e, or pre-window), fall back to a
// native OS dialog. CAPYBARA_AUTO_CONSENT=1 auto-approves (dev-only) for the
// CDP tests that can't click either surface.

// `settle` is the single resolver: it drops the pending entry and tears down the
// window/abort listeners, so it's safe to call from any of the three ways a wait
// ends — user answer, window destroyed, task aborted — and idempotent if two race.
type Pending = { settle: (allow: boolean) => void };
const pending = new Map<string, Pending>();
let counter = 0;

export function respondConsent(requestId: string, allow: boolean): void {
  pending.get(requestId)?.settle(allow);
}

export function requestDirectoryConsent(path: string, signal?: AbortSignal): Promise<boolean> {
  if (!app.isPackaged && process.env.CAPYBARA_AUTO_CONSENT === "1") return Promise.resolve(true);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isDestroyed()) return nativeDialog(path);
  if (signal?.aborted) return Promise.resolve(false);

  const wc = win.webContents;
  const requestId = `consent-${++counter}`;
  return new Promise<boolean>((resolve) => {
    const settle = (allow: boolean) => {
      if (!pending.delete(requestId)) return;
      wc.removeListener("destroyed", deny);
      signal?.removeEventListener("abort", deny);
      resolve(allow);
    };
    // A vanished window or a Stopped task ends the wait as a deny, so the agent's
    // tool call never hangs and the pending entry never leaks.
    const deny = () => settle(false);
    pending.set(requestId, { settle });
    wc.once("destroyed", deny);
    signal?.addEventListener("abort", deny, { once: true });
    wc.send("agent-event", { event: "consent_request", requestId, path });
  });
}

// Tell the renderer a folder was actually granted, carrying the NORMALIZED path
// from main's grant store — so the right-pane "Granted folders" reflects what was
// truly recorded, not the raw `~`/relative string the model happened to pass.
export function notifyGrant(path: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send("agent-event", { event: "grant_added", path });
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
