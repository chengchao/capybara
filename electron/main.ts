import { app, BrowserWindow } from "electron";
import path from "node:path";
import { ensureVm, setStatusEmitter, stopSupervisor, stopVm } from "./vm";

const DEV_URL = process.env.ELECTRON_DEV_URL;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    mainWindow = new BrowserWindow({
      width: 1024,
      height: 720,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    setStatusEmitter((status) => {
      mainWindow?.webContents.send("vm-status", status);
    });

    if (DEV_URL) {
      await mainWindow.loadURL(DEV_URL);
      mainWindow.webContents.openDevTools({ mode: "detach" });
    } else {
      await mainWindow.loadFile(
        path.join(__dirname, "..", "..", "dist", "index.html"),
      );
    }

    ensureVm().catch((e) => {
      process.stderr.write(`vm: ensure_vm failed: ${(e as Error).message}\n`);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let isShuttingDown = false;
  app.on("before-quit", async (event) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    event.preventDefault();
    await stopSupervisor();
    await Promise.race([
      stopVm(),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    app.exit(0);
  });
}
