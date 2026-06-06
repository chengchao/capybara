import { randomUUID } from "node:crypto";
import path from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";

import { runAgentTask } from "./agent/runTask";
import { respondConsent } from "./consent";
import { loadConversations, saveConversation } from "./conversations";
import { startLlmProxy, stopLlmProxy } from "./llmProxy";
import {
  effectiveModel,
  getAnthropicApiKey,
  hasStoredApiKey,
  setAnthropicApiKey,
  setModel,
} from "./settings";
import { ensureVm, getVmStatus, setStatusEmitter, stopSupervisor, stopVm } from "./vm";

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

type SettingsState = {
  hasApiKey: boolean;
  apiKeyPreview: string | null;
  unreadable: boolean;
  model: string;
};

function describeSettings(): SettingsState {
  const model = effectiveModel();
  const key = getAnthropicApiKey();
  if (key) {
    const preview = key.length > 11 ? `${key.slice(0, 7)}…${key.slice(-4)}` : "•••• set";
    return { hasApiKey: true, apiKeyPreview: preview, unreadable: false, model };
  }
  // A stored key that won't decrypt (locked/unavailable keyring, or copied from
  // another machine) is reported as unreadable — distinct from no key at all.
  return { hasApiKey: false, apiKeyPreview: null, unreadable: hasStoredApiKey(), model };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  const activeTasks = new Map<string, AbortController>();

  function createMainWindow() {
    // Anchor bundled-asset paths on app.getAppPath() (the project root in dev,
    // app.asar when packaged) rather than __dirname, which bundlers handle
    // inconsistently. vite-plugin-electron emits both main.cjs and preload.cjs
    // into dist-electron/, and the renderer build lands in dist/.
    const appPath = app.getAppPath();
    mainWindow = new BrowserWindow({
      width: 1024,
      height: 720,
      webPreferences: {
        preload: path.join(appPath, "dist-electron", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    if (DEV_URL) {
      mainWindow.loadURL(DEV_URL);
      mainWindow.webContents.openDevTools({ mode: "detach" });
    } else {
      mainWindow.loadFile(path.join(appPath, "dist", "index.html"));
    }
  }

  setStatusEmitter((status) => {
    mainWindow?.webContents.send("vm-status", status);
  });

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });

  ipcMain.handle("get-vm-status", () => getVmStatus());

  ipcMain.handle("get-settings", (): SettingsState => describeSettings());

  ipcMain.handle("set-anthropic-api-key", (_event, key: unknown): SettingsState => {
    if (typeof key !== "string") throw new Error("key must be a string");
    setAnthropicApiKey(key.trim());
    return describeSettings();
  });

  ipcMain.handle("set-model", (_event, model: unknown): SettingsState => {
    if (typeof model !== "string") throw new Error("model must be a string");
    setModel(model.trim());
    return describeSettings();
  });

  ipcMain.handle(
    "start-agent-task",
    async (
      event,
      args: { prompt?: unknown; resumeSessionId?: unknown },
    ): Promise<{ taskId: string }> => {
      const prompt = args?.prompt;
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("prompt is required");
      }
      const resumeSessionId =
        typeof args?.resumeSessionId === "string" ? args.resumeSessionId : undefined;
      const taskId = randomUUID();
      const controller = new AbortController();
      activeTasks.set(taskId, controller);
      runAgentTask(
        prompt,
        taskId,
        (msg) => event.sender.send("agent-event", msg),
        controller,
        resumeSessionId,
      )
        .catch((err: unknown) => {
          // runAgentTask emits its own task_finished on normal completion and on
          // handled errors, but a throw before that (e.g. the VM/supervisor failed
          // to boot, which happens after task_started) would skip it and leave the
          // renderer wedged in `running`. Always close the task out so the UI's
          // `busy` lock clears, surfacing the reason.
          if (event.sender.isDestroyed()) return;
          const text = `error: ${err instanceof Error ? err.message : String(err)}`;
          event.sender.send("agent-event", { event: "assistant_message", taskId, text });
          event.sender.send("agent-event", { event: "task_finished", taskId });
        })
        .finally(() => activeTasks.delete(taskId));
      return { taskId };
    },
  );

  ipcMain.handle("cancel-agent-task", (_event, taskId: unknown): void => {
    if (typeof taskId === "string") activeTasks.get(taskId)?.abort();
  });

  ipcMain.handle("respond-consent", (_event, args: { requestId?: unknown; allow?: unknown }) => {
    if (typeof args?.requestId === "string") respondConsent(args.requestId, args.allow === true);
  });

  ipcMain.handle("get-conversations", () => loadConversations());
  ipcMain.handle("save-conversation", (_event, conversation: unknown) =>
    saveConversation(conversation),
  );

  app.whenReady().then(async () => {
    // Start the loopback LLM proxy before anything can launch an agent task,
    // so runTask always finds it via getLlmProxy(). Binding a localhost port is
    // near-instant; the VM (which the agent needs anyway) takes far longer. A
    // bind failure must not leave a windowless, silent app — log it and still
    // show the window; a later task surfaces the failure via getLlmProxy().
    try {
      await startLlmProxy({
        getApiKey: () => getAnthropicApiKey() ?? process.env.ANTHROPIC_API_KEY,
      });
    } catch (e) {
      process.stderr.write(`llm proxy: failed to start: ${(e as Error).message}\n`);
    }
    createMainWindow();
    ensureVm().catch((e) => {
      process.stderr.write(`vm: ensure_vm failed: ${(e as Error).message}\n`);
    });
  });

  // macOS convention: clicking the Dock icon on a running headless app
  // recreates the window. Without this handler the user closes the only
  // window and has no way back to the UI short of quitting via the menu.
  app.on("activate", () => {
    if (mainWindow === null) createMainWindow();
  });

  app.on("window-all-closed", () => {});

  let isShuttingDown = false;
  app.on("before-quit", async (event) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    event.preventDefault();
    try {
      for (const controller of activeTasks.values()) controller.abort();
      await stopLlmProxy();
      await stopSupervisor();
      await Promise.race([stopVm(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    } catch (e) {
      process.stderr.write(`shutdown error: ${(e as Error).message}\n`);
    } finally {
      app.exit(0);
    }
  });
}
