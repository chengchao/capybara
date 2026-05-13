import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ensureVm,
  getVmStatus,
  requestSupervisor,
  setStatusEmitter,
  stopSupervisor,
  stopVm,
} from "./vm";
import { runAgentTask } from "./agent/runTask";

const DEV_URL = process.env.ELECTRON_DEV_URL;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  const activeTasks = new Map<string, AbortController>();

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  ipcMain.handle("get-vm-status", () => getVmStatus());

  ipcMain.handle("create-session", (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string") throw new Error("session_id required");
    return requestSupervisor("create_session", { session_id: sessionId });
  });

  ipcMain.handle(
    "connect-directory",
    (
      _e,
      args: {
        sessionId: string;
        hostPath: string;
        mountName: string;
        writable: boolean;
        replace: boolean;
      },
    ) =>
      requestSupervisor("connect_directory", {
        session_id: args.sessionId,
        host_path: args.hostPath,
        mount_name: args.mountName,
        writable: args.writable,
        replace: args.replace,
      }),
  );

  ipcMain.handle("delete-session", (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string") throw new Error("session_id required");
    return requestSupervisor("delete_session", { session_id: sessionId });
  });

  ipcMain.handle(
    "start-agent-task",
    async (event, prompt: unknown): Promise<{ taskId: string }> => {
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("prompt is required");
      }
      const taskId = randomUUID();
      const controller = new AbortController();
      activeTasks.set(taskId, controller);
      runAgentTask(
        prompt,
        taskId,
        (msg) => event.sender.send("agent-event", msg),
        controller,
      ).finally(() => activeTasks.delete(taskId));
      return { taskId };
    },
  );

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
    try {
      for (const controller of activeTasks.values()) controller.abort();
      await stopSupervisor();
      await Promise.race([
        stopVm(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } catch (e) {
      process.stderr.write(`shutdown error: ${(e as Error).message}\n`);
    } finally {
      app.exit(0);
    }
  });
}
