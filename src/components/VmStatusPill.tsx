import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { getVmStatus, subscribeVmStatus, type VmStatus } from "../lib/vm";

const pillTone: Record<VmStatus["kind"], string> = {
  starting: "bg-amber-100 text-amber-800",
  running: "bg-green-100 text-green-800",
  failed: "items-start max-w-full bg-red-100 text-red-800",
};

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

  let body: React.ReactNode;
  if (status.kind === "starting") {
    body = "🟡 Starting…";
  } else if (status.kind === "running") {
    body = "🟢 Running";
  } else {
    body = (
      <>
        🔴 Failed:&nbsp;
        <code className="max-h-24 overflow-auto font-mono break-words whitespace-pre-wrap">
          {status.reason}
        </code>
      </>
    );
  }

  return (
    <span
      className={cn(
        "mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium",
        pillTone[status.kind],
      )}
    >
      {body}
    </span>
  );
}
