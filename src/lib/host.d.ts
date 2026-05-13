declare global {
  interface Window {
    capybara: {
      createSession: (sessionId: string) => Promise<{
        sessionRoot: string;
        user: string;
      }>;
      connectDirectory: (args: {
        sessionId: string;
        hostPath: string;
        mountName: string;
        writable: boolean;
        replace: boolean;
      }) => Promise<{ guestPath: string }>;
      deleteSession: (sessionId: string) => Promise<{ ok: boolean }>;
      getVmStatus: () => Promise<VmStatus>;
      startAgentTask: (prompt: string) => Promise<{ taskId: string }>;
      onVmStatus: (callback: (status: VmStatus) => void) => () => void;
      onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;
    };
  }
}

export type VmStatus =
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "failed"; reason: string };

export type AgentEvent =
  | { event: "task_started"; taskId: string }
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
  | { event: "task_finished"; taskId: string };

export {};
