import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getVmStatus, subscribeVmStatus, type VmStatus } from "../lib/vm";

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4em",
  padding: "0.25em 0.7em",
  borderRadius: "999px",
  fontSize: "0.85em",
  fontWeight: 500,
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
};

const styleByKind: Record<VmStatus["kind"], React.CSSProperties> = {
  starting: { background: "#fef3c7", color: "#92400e" },
  running: { background: "#dcfce7", color: "#166534" },
  failed: { background: "#fee2e2", color: "#991b1b" },
};

export default function VmStatusPill() {
  const [status, setStatus] = useState<VmStatus>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    async function setup() {
      unlisten = await subscribeVmStatus((next) => {
        if (!cancelled) setStatus(next);
      });
      const current = await getVmStatus();
      if (!cancelled) setStatus(current);
    }

    setup();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const style = { ...baseStyle, ...styleByKind[status.kind] };

  if (status.kind === "starting") {
    return <span style={style}>🟡 Starting…</span>;
  }
  if (status.kind === "running") {
    return <span style={style}>🟢 Running</span>;
  }
  return (
    <span style={{ ...style, alignItems: "flex-start", maxWidth: "100%" }}>
      🔴 Failed:&nbsp;
      <pre
        style={{
          margin: 0,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {status.reason}
      </pre>
    </span>
  );
}
