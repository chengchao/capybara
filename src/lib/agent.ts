import type { AgentEvent } from "./host";

export type { AgentEvent };

export function startAgentTask(args: {
  prompt: string;
  resumeSessionId?: string;
}): Promise<{ taskId: string }> {
  return window.capybara.startAgentTask(args);
}

export function cancelAgentTask(taskId: string): Promise<void> {
  return window.capybara.cancelAgentTask(taskId);
}

export function respondConsent(requestId: string, allow: boolean): Promise<void> {
  return window.capybara.respondConsent(requestId, allow);
}

export function subscribeAgentEvents(cb: (event: AgentEvent) => void): () => void {
  return window.capybara.onAgentEvent(cb);
}
