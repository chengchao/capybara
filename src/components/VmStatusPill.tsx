import { useEffect, useState } from "react";
import { getVmStatus, subscribeVmStatus, type VmStatus } from "../lib/vm";

export default function VmStatusPill() {
  const [status, setStatus] = useState<VmStatus>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unlisten = subscribeVmStatus((next) => {
      if (cancelled) return;
      receivedEvent = true;
      setStatus(next);
    });
    getVmStatus().then((current) => {
      if (cancelled || receivedEvent) return;
      setStatus(current);
    });
    return () => {
      cancelled = true;
      unlisten();
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
