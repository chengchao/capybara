import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Unsubscribe = () => void;

const api = {
  getVmStatus: () => ipcRenderer.invoke("get-vm-status"),
  startAgentTask: (args: { prompt: string; resumeSessionId?: string }) =>
    ipcRenderer.invoke("start-agent-task", args),
  cancelAgentTask: (taskId: string) => ipcRenderer.invoke("cancel-agent-task", taskId),
  respondConsent: (requestId: string, allow: boolean) =>
    ipcRenderer.invoke("respond-consent", { requestId, allow }),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setAnthropicApiKey: (key: string) => ipcRenderer.invoke("set-anthropic-api-key", key),
  getConversations: () => ipcRenderer.invoke("get-conversations"),
  saveConversation: (conversation: unknown) =>
    ipcRenderer.invoke("save-conversation", conversation),
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
