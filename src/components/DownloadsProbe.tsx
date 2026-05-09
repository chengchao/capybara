import { useState } from "react";
import {
  connectDirectory,
  createSession,
  deleteSession,
  runAsSession,
} from "../lib/session";

const SESSION_ID = "downloadsprobe";

export default function DownloadsProbe() {
  const [busy, setBusy] = useState(false);
  const [sessionCreated, setSessionCreated] = useState(false);
  const [command, setCommand] = useState(
    "pwd && ls -ld /mnt/Downloads && find /mnt/Downloads -maxdepth 1 -type f | head",
  );
  const [lastCommand, setLastCommand] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [stdout, setStdout] = useState("");
  const [stderr, setStderr] = useState("");
  const [error, setError] = useState("");

  async function handleCreateSession() {
    setBusy(true);
    setLastCommand("");
    setExitCode(null);
    setStdout("");
    setStderr("");
    setError("");
    try {
      const session = await createSession(SESSION_ID);
      setSessionCreated(true);
      setLastCommand("create_session");
      setExitCode(0);
      setStdout(`session: ${session.user}\nroot: ${session.sessionRoot}\n`);
      setStderr("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectDownloads() {
    setBusy(true);
    setError("");
    try {
      if (!sessionCreated) {
        const session = await createSession(SESSION_ID);
        setSessionCreated(true);
        setStdout(`session: ${session.user}\nroot: ${session.sessionRoot}\n`);
      }
      const connected = await connectDirectory({
        sessionId: SESSION_ID,
        hostPath: "/host-home/Downloads",
        mountName: "Downloads",
        writable: true,
        replace: true,
      });
      setLastCommand(
        [
          `# connected: ${connected.guestPath}`,
          "connect_directory /host-home/Downloads",
        ].join("\n"),
      );
      setExitCode(0);
      setStdout((prev) => `${prev}connected: ${connected.guestPath}\n`);
      setStderr("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cleanup() {
    setBusy(true);
    setError("");
    try {
      await deleteSession(SESSION_ID);
      setSessionCreated(false);
      setLastCommand("delete_session");
      setExitCode(0);
      setStdout("session deleted\n");
      setStderr("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runCommand() {
    setBusy(true);
    setError("");
    try {
      const result = await runAsSession({
        sessionId: SESSION_ID,
        cwd: "/workspace",
        timeoutMs: 10000,
        command,
      });
      setLastCommand(command);
      setExitCode(result.exitCode);
      setStdout(result.stdout);
      setStderr(result.stderr);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="probe">
      <div className="probe-actions">
        <button type="button" onClick={handleCreateSession} disabled={busy}>
          Create Session
        </button>
        <button type="button" onClick={connectDownloads} disabled={busy}>
          Connect Downloads
        </button>
        <button type="button" onClick={runCommand} disabled={busy || !sessionCreated}>
          Run Command
        </button>
        <button type="button" onClick={cleanup} disabled={busy}>
          Delete Session
        </button>
      </div>
      <textarea
        className="probe-command"
        value={command}
        onChange={(e) => setCommand(e.currentTarget.value)}
        spellCheck={false}
      />
      <div className="probe-streams">
        <section className="probe-stream">
          <div className="probe-stream__label">command</div>
          <pre className="probe-output">{lastCommand || "(not run yet)"}</pre>
        </section>
        <section className="probe-stream">
          <div className="probe-stream__label">
            stdout {exitCode !== null ? `(exit ${exitCode})` : ""}
          </div>
          <pre className="probe-output">{stdout || "(empty)"}</pre>
        </section>
        <section className="probe-stream">
          <div className="probe-stream__label">stderr</div>
          <pre className="probe-output">{stderr || "(empty)"}</pre>
        </section>
      </div>
      {error && <pre className="probe-error">{error}</pre>}
    </section>
  );
}
