import { useEffect, useState } from "react";
import { startAgentTask, subscribeAgentEvents } from "../lib/agent";

export default function AgentProbe() {
  const [prompt, setPrompt] = useState("Organize my Downloads folder");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = subscribeAgentEvents((event) => {
      setEvents((prev) => [
        JSON.stringify(event, null, 2),
        ...prev,
      ].slice(0, 20));
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
    <section className="agent-probe">
      <div className="agent-probe__row">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          placeholder="Ask the agent..."
        />
        <button type="button" onClick={runAgent} disabled={busy}>
          Run Agent
        </button>
      </div>
      <pre className="agent-probe__events">
        {events.length ? events.join("\n\n") : "(no agent events yet)"}
      </pre>
      {error && <pre className="probe-error">{error}</pre>}
    </section>
  );
}
