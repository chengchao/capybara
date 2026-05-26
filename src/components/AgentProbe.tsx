import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { startAgentTask, subscribeAgentEvents } from "../lib/agent";

export default function AgentProbe() {
  const [prompt, setPrompt] = useState("Organize my Downloads folder");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resume, setResume] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeAgentEvents((event) => {
      if (event.event === "session_started") setSessionId(event.sessionId);
      setEvents((prev) => [JSON.stringify(event, null, 2), ...prev].slice(0, 20));
    });
    return unsubscribe;
  }, []);

  async function runAgent() {
    setBusy(true);
    setError("");
    try {
      await startAgentTask({
        prompt,
        resumeSessionId: resume && sessionId ? sessionId : undefined,
      });
      setEvents((prev) => ["sent start_task request", ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function newConversation() {
    setSessionId(null);
    setEvents([]);
  }

  return (
    <section className="mx-auto flex w-[min(960px,calc(100%-2rem))] flex-col items-stretch gap-3">
      <div className="flex gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          placeholder="Ask the agent..."
          className="flex-1"
        />
        <Button type="button" onClick={runAgent} disabled={busy}>
          Run Agent
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={resume}
            onChange={(e) => setResume(e.currentTarget.checked)}
          />
          Continue conversation
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={newConversation}
          disabled={busy || !sessionId}
        >
          New conversation
        </Button>
        <span className="text-muted-foreground">
          {sessionId ? `session ${sessionId.slice(0, 8)}…` : "no session yet"}
        </span>
      </div>
      <pre className="max-h-72 min-h-40 w-full overflow-auto rounded-md border bg-muted p-3 text-left font-mono text-sm break-words whitespace-pre-wrap">
        {events.length ? events.join("\n\n") : "(no agent events yet)"}
      </pre>
      {error && (
        <pre className="w-full rounded-md border border-destructive/30 bg-destructive/10 p-3 text-left font-mono text-sm break-words whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      )}
    </section>
  );
}
