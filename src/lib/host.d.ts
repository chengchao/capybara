declare global {
  interface Window {
    capybara: {
      getVmStatus: () => Promise<VmStatus>;
      startAgentTask: (args: {
        prompt: string;
        resumeSessionId?: string;
      }) => Promise<{ taskId: string }>;
      cancelAgentTask: (taskId: string) => Promise<void>;
      respondConsent: (requestId: string, allow: boolean) => Promise<void>;
      getSettings: () => Promise<ApiKeyState>;
      setAnthropicApiKey: (key: string) => Promise<ApiKeyState>;
      onVmStatus: (callback: (status: VmStatus) => void) => () => void;
      onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;
    };
  }
}

export type ApiKeyState = {
  hasApiKey: boolean;
  apiKeyPreview: string | null;
  unreadable: boolean;
};

export type VmStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "failed"; reason: string };

export type AgentEvent =
  | { event: "task_started"; taskId: string }
  | { event: "session_started"; taskId: string; sessionId: string }
  | { event: "assistant_message"; taskId: string; text: string }
  | {
      event: "tool_use";
      taskId: string;
      tool: string;
      input: unknown;
      toolUseId: string;
    }
  | {
      event: "tool_result";
      taskId: string;
      toolUseId: string;
      content: unknown;
      isError: boolean;
    }
  | { event: "task_finished"; taskId: string; sessionId?: string }
  // Not part of a task's emit stream — the consent broker (electron/consent.ts)
  // sends these to the renderer: `consent_request` drives an inline Allow/Deny
  // prompt; `grant_added` reports a folder main actually recorded (normalized
  // path) so the renderer's grant list mirrors main's authoritative store.
  | { event: "consent_request"; requestId: string; path: string }
  | { event: "grant_added"; path: string };
