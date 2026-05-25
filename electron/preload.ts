import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Unsubscribe = () => void;

const api = {
  getVmStatus: () => ipcRenderer.invoke("get-vm-status"),
  startAgentTask: (prompt: string) => ipcRenderer.invoke("start-agent-task", prompt),
  onVmStatus: (callback: (status: unknown) => void): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("vm-status", listener);
    return () => ipcRenderer.removeListener("vm-status", listener);
  },
  onAgentEvent: (callback: (event: unknown) => void): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("agent-event", listener);
    return () => ipcRenderer.removeListener("agent-event", listener);
  },
};

contextBridge.exposeInMainWorld("capybara", api);
