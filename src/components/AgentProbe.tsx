import { useEffect, useState } from "react";

import { Transcript } from "@/components/chat/Transcript";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addUser, applyEvent, emptyConversation } from "@/lib/transcript";

import { startAgentTask, subscribeAgentEvents } from "../lib/agent";

export default function AgentProbe() {
  const [prompt, setPrompt] = useState("Organize my Downloads folder");
  const [busy, setBusy] = useState(false);
  const [convo, setConvo] = useState(emptyConversation);
  const [error, setError] = useState("");
  const [resume, setResume] = useState(true);

  useEffect(() => subscribeAgentEvents((event) => setConvo((c) => applyEvent(c, event))), []);

  async function runAgent() {
    setBusy(true);
    setError("");
    const text = prompt;
    const resumeSessionId = resume && convo.sessionId ? convo.sessionId : undefined;
    setConvo((c) => addUser(c, text));
    try {
      await startAgentTask({ prompt: text, resumeSessionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function newConversation() {
    setConvo(emptyConversation());
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
          disabled={busy || !convo.sessionId}
        >
          New conversation
        </Button>
        <span className="text-muted-foreground">
          {convo.sessionId ? `session ${convo.sessionId.slice(0, 8)}…` : "no session yet"}
        </span>
      </div>
      <Transcript conversation={convo} />
      {error && (
        <pre className="w-full rounded-md border border-destructive/30 bg-destructive/10 p-3 text-left font-mono text-sm break-words whitespace-pre-wrap text-destructive">
          {error}
        </pre>
      )}
    </section>
  );
}
