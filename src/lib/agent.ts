import type { AgentEvent } from "./host";

export type { AgentEvent };

export function startAgentTask(prompt: string): Promise<{ taskId: string }> {
  return window.capybara.startAgentTask(prompt);
}

export function subscribeAgentEvents(
  cb: (event: AgentEvent) => void,
): () => void {
  return window.capybara.onAgentEvent(cb);
}
