import { app, BrowserWindow } from "electron";
import path from "node:path";

const DEV_URL = process.env.ELECTRON_DEV_URL;

// Single-instance lock — without this, double-launching the app starts a
// second ensure_vm / cleanup_orphans concurrently with the first instance,
// the exact concurrent-supervisor hazard PR #14 originally surfaced.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 1024,
      height: 720,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    if (DEV_URL) {
      win.loadURL(DEV_URL);
      win.webContents.openDevTools({ mode: "detach" });
    } else {
      win.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
