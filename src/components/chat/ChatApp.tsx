import { useEffect, useRef, useState } from "react";

import Settings from "@/components/Settings";
import { cancelAgentTask, respondConsent, startAgentTask, subscribeAgentEvents } from "@/lib/agent";
import { loadConversations, saveConversation } from "@/lib/conversationStore";
import {
  addUser,
  applyEvent,
  type Conversation,
  emptyConversation,
  resolveConsent,
} from "@/lib/transcript";
import { useVmStatus } from "@/lib/vm";

import { ConsentProvider } from "./consent-context";
import { ConversationView } from "./ConversationView";
import { InfoPane } from "./InfoPane";
import { Sidebar } from "./Sidebar";

export function ChatApp() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState("");
  const [infoOpen, setInfoOpen] = useState(true);
  const vm = useVmStatus();

  // The conversation that owns the in-flight task. Set synchronously at send()
  // time — before any event arrives — so the event stream routes deterministically
  // to the right conversation even when the user is viewing a different one. A ref
  // (not state) because the subscription closure must read the latest value.
  const runningIdRef = useRef<string | null>(null);

  // Serialized snapshot of what's on disk, keyed by conversation id, so the
  // persist effect can write only the conversations that actually changed (one
  // file each) rather than rewriting the whole history.
  const savedRef = useRef(new Map<string, string>());

  // Hydrate from the on-disk store once, seeding an empty conversation on first
  // run. Async (the store is a main-process directory), so the UI holds until the
  // list is known rather than flashing a stray empty conversation.
  useEffect(() => {
    let alive = true;
    void loadConversations().then((loaded) => {
      if (!alive) return;
      const seeded = loaded.length > 0 ? loaded : [emptyConversation()];
      // Seed the snapshot so hydration doesn't re-write every file it just read.
      for (const c of seeded) savedRef.current.set(c.id, JSON.stringify(c));
      setConversations(seeded);
      setCurrentId(seeded[0].id);
      setHydrated(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Persist changed conversations, debounced: a streaming task mutates its
  // conversation on every event, so coalesce the burst, then write only the files
  // whose content differs from the last-saved snapshot.
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => {
      for (const c of conversations) {
        const json = JSON.stringify(c);
        if (savedRef.current.get(c.id) === json) continue;
        savedRef.current.set(c.id, json);
        void saveConversation(c);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [conversations, hydrated]);

  useEffect(
    () =>
      subscribeAgentEvents((event) => {
        const target = runningIdRef.current;
        if (!target) return;
        setConversations((cs) => cs.map((c) => (c.id === target ? applyEvent(c, event) : c)));
        if (event.event === "task_finished") runningIdRef.current = null;
      }),
    [],
  );

  // Hold the chrome until hydration settles (a sub-frame on a local file read).
  if (!hydrated) return null;

  const convo = conversations.find((c) => c.id === currentId) ?? conversations[0];
  const busy = conversations.some((c) => c.status === "running");

  async function send(text: string) {
    if (busy) return;
    setError("");
    // Continuing a conversation resumes its SDK session; a fresh one has none.
    const resumeSessionId = convo.sessionId ?? undefined;
    runningIdRef.current = convo.id;
    setConversations((cs) =>
      cs.map((c) => (c.id === convo.id ? { ...addUser(c, text), status: "running" } : c)),
    );
    try {
      await startAgentTask({ prompt: text, resumeSessionId });
    } catch (e) {
      runningIdRef.current = null;
      setConversations((cs) => cs.map((c) => (c.id === convo.id ? { ...c, status: "done" } : c)));
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Stop the one in-flight task, whichever conversation owns it. The taskId is
  // captured from the event stream (set the instant the run goes `running`), so
  // the Stop button never races a not-yet-set id.
  function stop() {
    const running = conversations.find((c) => c.status === "running");
    if (running?.taskId) void cancelAgentTask(running.taskId);
  }

  // Tell main the user's choice and flip the card in the conversation that raised
  // it (the running one). The granted folder appears only when main confirms it
  // via a `grant_added` event, so the UI mirrors main's authoritative store.
  function respond(requestId: string, decision: "allow" | "deny") {
    void respondConsent(requestId, decision === "allow");
    const target = runningIdRef.current ?? currentId;
    setConversations((cs) =>
      cs.map((c) => (c.id === target ? resolveConsent(c, requestId, decision) : c)),
    );
  }

  // A new conversation goes to the top of the list and becomes current. Disabled
  // in the UI while a task runs (only one runs at a time), so no guard needed.
  function newTask() {
    const fresh = emptyConversation();
    setConversations((cs) => [fresh, ...cs]);
    setCurrentId(fresh.id);
    setError("");
  }

  function selectConversation(id: string) {
    setCurrentId(id);
    setError("");
  }

  const running = convo.status === "running";

  return (
    <ConsentProvider value={respond}>
      <div
        className="grid h-screen w-screen overflow-hidden bg-background text-foreground"
        style={{
          gridTemplateColumns: infoOpen ? "240px minmax(0,1fr) 300px" : "240px minmax(0,1fr)",
        }}
      >
        <Sidebar
          conversations={conversations}
          currentId={currentId}
          vm={vm}
          busy={busy}
          onSelect={selectConversation}
          onNewTask={newTask}
        />
        <ConversationView
          conversation={convo}
          running={running}
          busy={busy}
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
