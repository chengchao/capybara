import { useEffect, useState } from "react";

import type { VmStatus } from "./host";

export type { VmStatus };

export function getVmStatus(): Promise<VmStatus> {
  return window.capybara.getVmStatus();
}

export function subscribeVmStatus(cb: (status: VmStatus) => void): () => void {
  return window.capybara.onVmStatus(cb);
}

// Live VM status, racing the subscription against a one-shot fetch so it never
// flashes stale state (the subscription wins). Replaces the old VmStatusPill's
// inline effect, now shared by the shell.
export function useVmStatus(): VmStatus {
  const [status, setStatus] = useState<VmStatus>({ kind: "starting" });
  useEffect(() => {
    let cancelled = false;
    let received = false;
    const unlisten = subscribeVmStatus((next) => {
      if (cancelled) return;
      received = true;
      setStatus(next);
    });
    getVmStatus().then((current) => {
      if (!cancelled && !received) setStatus(current);
    });
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);
  return status;
}
