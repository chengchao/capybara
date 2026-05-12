import "./host";

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

export function startAgentTask(prompt: string): Promise<{ taskId: string }> {
  return window.capybara.startAgentTask(prompt);
}

export function subscribeAgentEvents(
  cb: (event: AgentEvent) => void,
): () => void {
  return window.capybara.onAgentEvent((event) => cb(event as AgentEvent));
}
