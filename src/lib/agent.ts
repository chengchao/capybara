import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AgentEvent =
  | { event: "agent_ready" }
  | { event: "task_started"; taskId: string }
  | { event: "assistant_message"; taskId: string; text: string }
  | { event: "task_finished"; taskId: string }
  | { event: "agent_exited"; code: number | null; signal: number | null }
  | { event: "agent_protocol_error"; error: string; line: string }
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export function startAgentTask(prompt: string): Promise<void> {
  return invoke<void>("start_agent_task", { prompt });
}

export function subscribeAgentEvents(
  cb: (event: AgentEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent-event", (event) => cb(event.payload));
}
