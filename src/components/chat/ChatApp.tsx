import { useEffect, useState } from "react";

import Settings from "@/components/Settings";
import { cancelAgentTask, respondConsent, startAgentTask, subscribeAgentEvents } from "@/lib/agent";
import { addUser, applyEvent, emptyConversation, resolveConsent } from "@/lib/transcript";
import { useVmStatus } from "@/lib/vm";

import { ConsentProvider } from "./consent-context";
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

  // The task id is captured from the event stream (set the instant the run goes
  // `running`), so the Stop button never races a not-yet-set id.
  function stop() {
    if (convo.taskId) void cancelAgentTask(convo.taskId);
  }

  // Tell main the user's choice and flip the card. The granted folder appears in
  // the list only when main confirms it via a `grant_added` event (applyEvent),
  // so the UI mirrors main's authoritative store rather than the raw request.
  function respond(requestId: string, decision: "allow" | "deny") {
    void respondConsent(requestId, decision === "allow");
    setConvo((c) => resolveConsent(c, requestId, decision));
  }

  function newTask() {
    setConvo(emptyConversation());
    setError("");
  }

  return (
    <ConsentProvider value={respond}>
      <div
        className="grid h-screen w-screen overflow-hidden bg-background text-foreground"
        style={{
          gridTemplateColumns: infoOpen ? "240px minmax(0,1fr) 300px" : "240px minmax(0,1fr)",
        }}
      >
        <Sidebar
          conversation={convo}
          vm={vm}
          running={convo.status === "running"}
          onNewTask={newTask}
        />
        <ConversationView
          conversation={convo}
          running={convo.status === "running"}
          error={error}
          infoOpen={infoOpen}
          onToggleInfo={() => setInfoOpen((v) => !v)}
          onSend={send}
          onStop={stop}
        />
        {infoOpen && <InfoPane conversation={convo} vm={vm} onClose={() => setInfoOpen(false)} />}
        <Settings />
      </div>
    </ConsentProvider>
  );
}
