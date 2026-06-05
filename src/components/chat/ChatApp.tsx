import { useEffect, useState } from "react";

import Settings from "@/components/Settings";
import { startAgentTask, subscribeAgentEvents } from "@/lib/agent";
import { addUser, applyEvent, emptyConversation } from "@/lib/transcript";
import { useVmStatus } from "@/lib/vm";

import { ConversationView } from "./ConversationView";
import { InfoPane } from "./InfoPane";
import { Sidebar } from "./Sidebar";

export function ChatApp() {
  const [convo, setConvo] = useState(emptyConversation);
  const [error, setError] = useState("");
  const [infoOpen, setInfoOpen] = useState(true);
  const vm = useVmStatus();

  useEffect(() => subscribeAgentEvents((event) => setConvo((c) => applyEvent(c, event))), []);

  async function send(text: string) {
    setError("");
    // Continuing the same conversation resumes its session; "New task" clears it.
    const resumeSessionId = convo.sessionId ?? undefined;
    setConvo((c) => addUser(c, text));
    try {
      await startAgentTask({ prompt: text, resumeSessionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function newTask() {
    setConvo(emptyConversation());
    setError("");
  }

  return (
    <div
      className="grid h-screen w-screen overflow-hidden bg-background text-foreground"
      style={{
        gridTemplateColumns: infoOpen ? "240px minmax(0,1fr) 300px" : "240px minmax(0,1fr)",
      }}
    >
      <Sidebar conversation={convo} vm={vm} onNewTask={newTask} />
      <ConversationView
        conversation={convo}
        running={convo.status === "running"}
        error={error}
        infoOpen={infoOpen}
        onToggleInfo={() => setInfoOpen((v) => !v)}
        onSend={send}
      />
      {infoOpen && <InfoPane conversation={convo} vm={vm} onClose={() => setInfoOpen(false)} />}
      <Settings />
    </div>
  );
}
