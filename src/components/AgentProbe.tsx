import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { startAgentTask, subscribeAgentEvents } from "../lib/agent";

export default function AgentProbe() {
  const [prompt, setPrompt] = useState("Organize my Downloads folder");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeAgentEvents((event) => {
      setEvents((prev) => [JSON.stringify(event, null, 2), ...prev].slice(0, 20));
    });
    return unsubscribe;
  }, []);

  async function runAgent() {
    setBusy(true);
    setError("");
    try {
      await startAgentTask(prompt);
      setEvents((prev) => ["sent start_task request", ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
