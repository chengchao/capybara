import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getVmStatus, subscribeVmStatus, type VmStatus } from "../lib/vm";

export default function VmStatusPill() {
  const [status, setStatus] = useState<VmStatus>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    let unlisten: UnlistenFn | undefined;

    async function setup() {
      unlisten = await subscribeVmStatus((next) => {
        if (cancelled) return;
        receivedEvent = true;
        setStatus(next);
      });
      const current = await getVmStatus();
      if (cancelled || receivedEvent) return;
      setStatus(current);
    }

    setup();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const className = `vm-pill vm-pill--${status.kind}`;
  let body: React.ReactNode;
  if (status.kind === "starting") {
    body = "🟡 Starting…";
  } else if (status.kind === "running") {
    body = "🟢 Running";
  } else {
    body = (
      <>
        🔴 Failed:&nbsp;
        <code className="vm-pill__reason">{status.reason}</code>
      </>
    );
  }
  return <span className={className}>{body}</span>;
}
